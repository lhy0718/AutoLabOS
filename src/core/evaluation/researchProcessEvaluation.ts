import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import {
  GRAPH_NODE_ORDER,
  GraphNodeId,
  RunEvidenceAdequacyProjection,
  RunRecord,
  RunResearchProcessCheckProjection,
  RunResearchProcessProjection,
  RunReviewAssuranceProjection
} from "../../types.js";
import {
  ExperimentContract,
  validateExperimentContract
} from "../experiments/experimentContract.js";
import { auditLongRunResumeSurfaces } from "../validation/longRunResumeAudit.js";
import { hashCanonical } from "../canonicalHash.js";

type JsonRead =
  | { status: "missing" }
  | { status: "malformed" }
  | { status: "available"; value: Record<string, unknown> };

const POLICY_NOTE =
  "This process projection is independent of manuscript or benchmark score. It verifies artifact-backed research-process integrity and is not external scientific validation.";

export async function buildRunResearchProcessProjection(input: {
  runDir: string;
  workspaceRoot?: string;
  run: RunRecord;
  evidenceAdequacy?: RunEvidenceAdequacyProjection;
  reviewAssurance?: RunReviewAssuranceProjection;
}): Promise<RunResearchProcessProjection> {
  const designStarted = nodeStarted(input.run, "design_experiments");
  const executionStarted = nodeStarted(input.run, "run_experiments");
  const analysisStarted = nodeStarted(input.run, "analyze_results");
  const reviewStarted = nodeStarted(input.run, "review");
  const paperStarted = nodeStarted(input.run, "write_paper");

  const [
    contract,
    portfolio,
    manifest,
    metrics,
    objectiveEvaluation,
    verification,
    executionEnvelope,
    executionReceipt,
    analysis,
    claimEvidence,
    resumeIssues
  ] = await Promise.all([
    readJson(path.join(input.runDir, "experiment_contract.json")),
    readJson(path.join(input.runDir, "experiment_portfolio.json")),
    readJson(path.join(input.runDir, "run_manifest.json")),
    readJson(path.join(input.runDir, "metrics.json")),
    readJson(path.join(input.runDir, "objective_evaluation.json")),
    readJson(path.join(input.runDir, "run_experiments_verify_report.json")),
    readJson(path.join(input.runDir, "execution", "execution_envelope.json")),
    readJson(path.join(input.runDir, "execution", "execution_receipt.json")),
    readJson(path.join(input.runDir, "result_analysis.json")),
    readJson(path.join(input.runDir, "paper", "claim_evidence_table.json")),
    Number(input.run.graph.checkpointSeq || 0) > 0
      ? auditLongRunResumeSurfaces({ run: input.run, runDir: input.runDir })
      : Promise.resolve([])
  ]);

  const executionGrounding = await evaluateExecutionGrounding(
    executionStarted,
    metrics,
    objectiveEvaluation,
    verification,
    executionEnvelope,
    executionReceipt,
    input.workspaceRoot || input.runDir
  );
  const checks: RunResearchProcessCheckProjection[] = [
    evaluateHypothesisContract(designStarted, contract),
    evaluateObjectiveAcceptanceSeparation(designStarted, contract),
    evaluatePlanExecutionAlignment(executionStarted, portfolio, manifest, input.run.id),
    executionGrounding,
    evaluateHypothesisDisposition(analysisStarted, analysis),
    evaluateEvidenceAdequacy(analysisStarted, input.evidenceAdequacy),
    evaluateIndependentValidation(reviewStarted, input.reviewAssurance),
    evaluateClaimEvidenceChain(paperStarted, claimEvidence),
    evaluateCheckpointResume(input.run, resumeIssues)
  ];
  const requiredChecks = checks.filter((check) => check.required);
  const blockerCount = requiredChecks.filter((check) =>
    check.status === "fail" || check.status === "invalid"
  ).length;
  const passedRequiredCheckCount = requiredChecks.filter((check) => check.status === "pass").length;
  const status =
    requiredChecks.length === 0
      ? "unmeasured"
      : blockerCount > 0
        ? "blocked"
        : passedRequiredCheckCount === requiredChecks.length
          ? "pass"
          : "partial";
  const reasonCodes = [...new Set(
    requiredChecks.flatMap((check) => check.reason_codes)
  )];

  return {
    version: 1,
    status,
    trusted: status === "pass",
    paper_ready_eligible: reviewStarted && status === "pass",
    required_check_count: requiredChecks.length,
    passed_required_check_count: passedRequiredCheckCount,
    blocker_count: blockerCount,
    reason_codes: reasonCodes,
    checks,
    policy_note: POLICY_NOTE
  };
}

function evaluateHypothesisContract(
  required: boolean,
  artifact: JsonRead
): RunResearchProcessCheckProjection {
  const artifactRefs = [{ label: "Experiment contract", path: "experiment_contract.json" }];
  if (!required) return notApplicable("hypothesis_contract");
  if (artifact.status === "missing") {
    return check("hypothesis_contract", "unmeasured", true, ["hypothesis_contract_missing"], []);
  }
  if (artifact.status === "malformed" || artifact.value.version !== 2) {
    return check("hypothesis_contract", "invalid", true, ["hypothesis_contract_invalid"], artifactRefs);
  }
  const validation = validateExperimentContract(artifact.value as unknown as ExperimentContract);
  return validation.valid
    ? check("hypothesis_contract", "pass", true, [], artifactRefs)
    : check(
        "hypothesis_contract",
        "fail",
        true,
        ["hypothesis_contract_failed", ...validation.issues.map(toReasonCode)],
        artifactRefs
      );
}

function evaluateObjectiveAcceptanceSeparation(
  required: boolean,
  artifact: JsonRead
): RunResearchProcessCheckProjection {
  const id = "objective_acceptance_separation" as const;
  const refs = [{ label: "Experiment contract", path: "experiment_contract.json" }];
  if (!required) return notApplicable(id);
  if (artifact.status === "missing") {
    return check(id, "unmeasured", true, ["objective_acceptance_contract_missing"], []);
  }
  if (artifact.status === "malformed") {
    return check(id, "invalid", true, ["objective_acceptance_contract_invalid"], refs);
  }
  const plan = isRecord(artifact.value.results_plan) ? artifact.value.results_plan : undefined;
  const metrics = plan && Array.isArray(plan.required_metrics) ? plan.required_metrics : [];
  const comparisons = plan && Array.isArray(plan.required_comparisons) ? plan.required_comparisons : [];
  const expectedEffect = textValue(artifact.value.expected_metric_effect);
  const abortCondition = textValue(artifact.value.abort_condition);
  const retentionRule = textValue(artifact.value.keep_or_discard_rule);
  const outcomeDependent =
    /(keep|retain|discard|stop|abort).{0,40}(improv|better|positive|significant|threshold)/iu.test(
      [abortCondition, retentionRule].filter(Boolean).join(" ")
    );
  const valid =
    metrics.length > 0
    && comparisons.length > 0
    && Boolean(expectedEffect)
    && Boolean(abortCondition)
    && Boolean(retentionRule)
    && !outcomeDependent;
  return valid
    ? check(id, "pass", true, [], refs)
    : check(
        id,
        "fail",
        true,
        ["objective_acceptance_not_separated"],
        refs
      );
}

function evaluatePlanExecutionAlignment(
  required: boolean,
  portfolio: JsonRead,
  manifest: JsonRead,
  runId: string
): RunResearchProcessCheckProjection {
  const id = "plan_execution_alignment" as const;
  const refs = [
    { label: "Experiment portfolio", path: "experiment_portfolio.json" },
    { label: "Run manifest", path: "run_manifest.json" }
  ];
  if (!required) return notApplicable(id);
  if (portfolio.status === "missing" || manifest.status === "missing") {
    return check(id, "unmeasured", true, ["plan_execution_artifact_missing"], refsForAvailable([
      [portfolio, refs[0]],
      [manifest, refs[1]]
    ]));
  }
  if (portfolio.status === "malformed" || manifest.status === "malformed") {
    return check(id, "invalid", true, ["plan_execution_artifact_invalid"], refs);
  }
  const manifestPortfolio = isRecord(manifest.value.portfolio) ? manifest.value.portfolio : {};
  const portfolioModel = textValue(portfolio.value.execution_model);
  const manifestModel = textValue(manifest.value.execution_model);
  const portfolioPrimary = textValue(portfolio.value.primary_trial_group_id);
  const manifestPrimary = textValue(manifestPortfolio.primary_trial_group_id);
  const manifestRunId = textValue(manifest.value.run_id);
  const aligned =
    Boolean(portfolioModel)
    && portfolioModel === manifestModel
    && Boolean(portfolioPrimary)
    && portfolioPrimary === manifestPrimary
    && (!manifestRunId || manifestRunId === runId);
  return aligned
    ? check(id, "pass", true, [], refs)
    : check(id, "fail", true, ["plan_execution_binding_mismatch"], refs);
}

async function evaluateExecutionGrounding(
  required: boolean,
  metrics: JsonRead,
  objective: JsonRead,
  verification: JsonRead,
  envelope: JsonRead,
  receipt: JsonRead,
  workspaceRoot: string
): Promise<RunResearchProcessCheckProjection> {
  const id = "execution_grounding" as const;
  const refs = [
    { label: "Metrics", path: "metrics.json" },
    { label: "Objective evaluation", path: "objective_evaluation.json" },
    { label: "Execution verification", path: "run_experiments_verify_report.json" },
    { label: "Execution envelope", path: "execution/execution_envelope.json" },
    { label: "Execution receipt", path: "execution/execution_receipt.json" }
  ];
  if (!required) return notApplicable(id);
  if (
    metrics.status === "malformed"
    || objective.status === "malformed"
    || verification.status === "malformed"
    || envelope.status === "malformed"
    || receipt.status === "malformed"
  ) {
    return check(id, "invalid", true, ["execution_artifact_invalid"], refsForAvailable([
      [metrics, refs[0]],
      [objective, refs[1]],
      [verification, refs[2]],
      [envelope, refs[3]],
      [receipt, refs[4]]
    ]));
  }
  if (
    metrics.status === "missing"
    || objective.status === "missing"
    || verification.status === "missing"
    || envelope.status === "missing"
    || receipt.status === "missing"
  ) {
    const reasonCodes = [
      "execution_artifact_missing",
      ...(envelope.status === "missing" ? ["execution_envelope_missing"] : []),
      ...(receipt.status === "missing" ? ["execution_receipt_missing"] : [])
    ];
    return check(id, "unmeasured", true, reasonCodes, refsForAvailable([
      [metrics, refs[0]],
      [objective, refs[1]],
      [verification, refs[2]],
      [envelope, refs[3]],
      [receipt, refs[4]]
    ]));
  }
  const envelopeIntegrity = validateExecutionEnvelopeIntegrity(envelope.value);
  const receiptIntegrity = validateExecutionReceiptIntegrity(receipt.value, envelope.value);
  const outputIntegrity = await validateExecutionOutputIntegrity(
    receipt.value,
    envelope.value,
    workspaceRoot
  );
  if (!envelopeIntegrity.valid || !receiptIntegrity.valid || !outputIntegrity.valid) {
    return check(id, "invalid", true, [
      ...envelopeIntegrity.reasonCodes,
      ...receiptIntegrity.reasonCodes,
      ...outputIntegrity.reasonCodes
    ], refs);
  }
  const verificationStatus = textValue(verification.value.status);
  const verificationStage = textValue(verification.value.stage);
  const objectiveStatus = textValue(objective.value.status);
  const deviceDeclarationValid = validateExecutionDeviceDeclaration(envelope.value);
  const assurance = isRecord(receipt.value.assurance) ? receipt.value.assurance : {};
  const assuranceValid = [
    "environment_allowlist_enforced",
    "workspace_boundary_enforced",
    "input_hashes_verified",
    "timeout_enforced",
    "network_policy_enforced",
    "mount_isolation_enforced",
    "device_policy_enforced"
  ].every((field) => assurance[field] === true);
  const grounded =
    verificationStatus === "pass"
    && verificationStage === "success"
    && Boolean(objectiveStatus)
    && objectiveStatus !== "missing"
    && Object.keys(metrics.value).length > 0
    && receipt.value.status === "completed"
    && receipt.value.enforcement === "enforced"
    && receipt.value.paper_grade_eligible === true
    && receipt.value.required_outputs_present === true
    && assuranceValid
    && deviceDeclarationValid;
  return grounded
    ? check(id, "pass", true, [], refs)
    : check(id, "fail", true, [
        "execution_not_verified",
        ...(receipt.value.paper_grade_eligible === true
          ? []
          : ["execution_envelope_not_paper_grade"]),
        ...(assuranceValid ? [] : ["execution_assurance_incomplete"]),
        ...(deviceDeclarationValid ? [] : ["execution_device_declaration_incomplete"]),
        ...readReasonCodes(receipt.value.reason_codes)
      ], refs);
}

function validateExecutionDeviceDeclaration(envelope: Record<string, unknown>): boolean {
  const devices = isRecord(envelope.devices) ? envelope.devices : undefined;
  if (!devices) {
    return false;
  }
  const policy = textValue(devices.policy);
  const requestedGpuCount = devices.requested_gpu_count;
  const visibleDeviceIds = Array.isArray(devices.visible_device_ids)
    ? devices.visible_device_ids.filter(nonEmptyString)
    : [];
  if (policy === "cpu_only") {
    return requestedGpuCount === 0 && visibleDeviceIds.length === 0;
  }
  return policy === "nvidia_gpu"
    && typeof requestedGpuCount === "number"
    && Number.isSafeInteger(requestedGpuCount)
    && requestedGpuCount > 0
    && visibleDeviceIds.length === requestedGpuCount
    && new Set(visibleDeviceIds).size === visibleDeviceIds.length
    && visibleDeviceIds.every((id) => /^\d+$/u.test(id));
}

async function validateExecutionOutputIntegrity(
  receipt: Record<string, unknown>,
  envelope: Record<string, unknown>,
  workspaceRoot: string
): Promise<{ valid: boolean; reasonCodes: string[] }> {
  const expectedOutputs = Array.isArray(envelope.expected_outputs)
    ? envelope.expected_outputs.filter(isRecord)
    : [];
  const outputArtifacts = Array.isArray(receipt.output_artifacts)
    ? receipt.output_artifacts.filter(isRecord)
    : [];
  const requiredPaths = expectedOutputs
    .filter((item) => item.required === true)
    .map((item) => textValue(item.path))
    .filter(nonEmptyString);
  if (requiredPaths.length === 0) {
    return { valid: false, reasonCodes: ["execution_required_output_binding_missing"] };
  }

  for (const requiredPath of requiredPaths) {
    const binding = outputArtifacts.find((item) =>
      item.required === true && textValue(item.path) === requiredPath
    );
    const sha256 = binding ? textValue(binding.sha256) : undefined;
    if (!binding || !sha256 || !/^[a-f0-9]{64}$/u.test(sha256)) {
      return { valid: false, reasonCodes: ["execution_output_binding_invalid"] };
    }
    const absolutePath = resolveWorkspaceArtifactPath(workspaceRoot, requiredPath);
    if (!absolutePath) {
      return { valid: false, reasonCodes: ["execution_output_path_invalid"] };
    }
    const canonicalRoot = await fs.realpath(workspaceRoot).catch(() => undefined);
    const canonicalOutput = await fs.realpath(absolutePath).catch(() => undefined);
    if (
      !canonicalRoot
      || !canonicalOutput
      || !isPathInsideOrEqual(canonicalOutput, canonicalRoot)
    ) {
      return { valid: false, reasonCodes: ["execution_output_missing_or_outside_workspace"] };
    }
    const observedSha256 = await hashFile(absolutePath).catch(() => undefined);
    if (observedSha256 !== sha256) {
      return { valid: false, reasonCodes: ["execution_output_hash_mismatch"] };
    }
  }
  return { valid: true, reasonCodes: [] };
}

function resolveWorkspaceArtifactPath(workspaceRoot: string, artifactPath: string): string | undefined {
  if (path.isAbsolute(artifactPath)) {
    return undefined;
  }
  const root = path.resolve(workspaceRoot);
  const candidate = path.resolve(root, artifactPath);
  return isPathInsideOrEqual(candidate, root) ? candidate : undefined;
}

function isPathInsideOrEqual(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function validateExecutionEnvelopeIntegrity(value: Record<string, unknown>): {
  valid: boolean;
  reasonCodes: string[];
} {
  if (value.version !== 1) {
    return { valid: false, reasonCodes: ["execution_envelope_version_invalid"] };
  }
  const envelopeId = textValue(value.envelope_id);
  const envelopeSha256 = textValue(value.envelope_sha256);
  const payload = { ...value };
  delete payload.envelope_id;
  delete payload.envelope_sha256;
  const observedSha256 = hashCanonical(payload);
  const valid =
    Boolean(envelopeId)
    && envelopeId === `exec_${observedSha256.slice(0, 24)}`
    && envelopeSha256 === observedSha256;
  return valid
    ? { valid: true, reasonCodes: [] }
    : { valid: false, reasonCodes: ["execution_envelope_integrity_invalid"] };
}

function validateExecutionReceiptIntegrity(
  value: Record<string, unknown>,
  envelope: Record<string, unknown>
): {
  valid: boolean;
  reasonCodes: string[];
} {
  if (value.version !== 1) {
    return { valid: false, reasonCodes: ["execution_receipt_version_invalid"] };
  }
  const receiptSha256 = textValue(value.receipt_sha256);
  const payload = { ...value };
  delete payload.receipt_sha256;
  const hashValid = receiptSha256 === hashCanonical(payload);
  const bindingValid =
    value.envelope_id === envelope.envelope_id
    && value.envelope_sha256 === envelope.envelope_sha256
    && value.run_id === envelope.run_id
    && value.phase === envelope.phase
    && value.attempt === envelope.attempt;
  return hashValid && bindingValid
    ? { valid: true, reasonCodes: [] }
    : { valid: false, reasonCodes: ["execution_receipt_integrity_invalid"] };
}

function readReasonCodes(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter(nonEmptyString)
        .map(toReasonCode)
        .filter(Boolean)
    : [];
}

function evaluateHypothesisDisposition(
  required: boolean,
  analysis: JsonRead
): RunResearchProcessCheckProjection {
  const id = "hypothesis_disposition" as const;
  const refs = [{ label: "Result analysis", path: "result_analysis.json" }];
  if (!required) return notApplicable(id);
  if (analysis.status === "missing") {
    return check(id, "unmeasured", true, ["hypothesis_disposition_missing"], []);
  }
  if (analysis.status === "malformed") {
    return check(id, "invalid", true, ["result_analysis_invalid"], refs);
  }
  const comparisons = Array.isArray(analysis.value.condition_comparisons)
    ? analysis.value.condition_comparisons.filter(isRecord)
    : [];
  const primaryId = textValue(analysis.value.primary_comparison_id);
  const primary = comparisons.find((item) => item.id === primaryId) || comparisons[0];
  return primary && typeof primary.hypothesis_supported === "boolean"
    ? check(id, "pass", true, [], refs)
    : check(id, "fail", true, ["hypothesis_disposition_not_explicit"], refs);
}

function evaluateEvidenceAdequacy(
  required: boolean,
  projection: RunEvidenceAdequacyProjection | undefined
): RunResearchProcessCheckProjection {
  const id = "evidence_adequacy" as const;
  if (!required) return notApplicable(id);
  if (!projection) {
    return check(id, "unmeasured", true, ["evidence_adequacy_unmeasured"], []);
  }
  const refs = projection.artifact_refs.map((artifact) => ({
    label: artifact.label,
    path: artifact.path
  }));
  if (projection.status === "invalid") {
    return check(id, "invalid", true, projection.reason_codes, refs);
  }
  return projection.trusted && projection.integrity_valid && projection.overall_status === "pass"
    ? check(id, "pass", true, [], refs)
    : check(id, "fail", true, projection.reason_codes.length > 0
      ? projection.reason_codes
      : ["evidence_adequacy_not_passed"], refs);
}

function evaluateIndependentValidation(
  required: boolean,
  projection: RunReviewAssuranceProjection | undefined
): RunResearchProcessCheckProjection {
  const id = "independent_validation" as const;
  if (!required) return notApplicable(id);
  if (!projection || projection.status === "not_started" || projection.status === "missing") {
    return check(id, "unmeasured", true, ["independent_validation_missing"], []);
  }
  const refs = projection.artifact_refs.map((artifact) => ({
    label: artifact.label,
    path: artifact.path
  }));
  if (projection.status === "invalid") {
    return check(id, "invalid", true, projection.reason_codes, refs);
  }
  return projection.trusted
    && projection.input_manifest_valid
    && projection.gate_report_valid
    && projection.assurance_valid
    && projection.handoff_valid
    && projection.model_review_bundle_valid
    ? check(id, "pass", true, [], refs)
    : check(id, "fail", true, projection.reason_codes.length > 0
      ? projection.reason_codes
      : ["independent_validation_not_trusted"], refs);
}

function evaluateClaimEvidenceChain(
  required: boolean,
  artifact: JsonRead
): RunResearchProcessCheckProjection {
  const id = "claim_evidence_chain" as const;
  const refs = [{ label: "Claim-evidence table", path: "paper/claim_evidence_table.json" }];
  if (!required) return notApplicable(id);
  if (artifact.status === "missing") {
    return check(id, "unmeasured", true, ["claim_evidence_table_missing"], []);
  }
  if (artifact.status === "malformed") {
    return check(id, "invalid", true, ["claim_evidence_table_invalid"], refs);
  }
  const claims = Array.isArray(artifact.value.claims)
    ? artifact.value.claims.filter(isRecord)
    : [];
  const valid = claims.length > 0 && claims.every((claim) => {
    const claimId = nonEmptyString(claim.claim_id);
    const artifactRefs = Array.isArray(claim.artifact_refs)
      ? claim.artifact_refs.filter(nonEmptyString)
      : [];
    const citationRefs = Array.isArray(claim.citation_refs)
      ? claim.citation_refs.filter(nonEmptyString)
      : [];
    return Boolean(claimId) && artifactRefs.length + citationRefs.length > 0;
  });
  return valid
    ? check(id, "pass", true, [], refs)
    : check(id, "fail", true, ["claim_evidence_chain_incomplete"], refs);
}

function evaluateCheckpointResume(
  run: RunRecord,
  issues: Array<{ code: string }>
): RunResearchProcessCheckProjection {
  const id = "checkpoint_resume_assurance" as const;
  if (Number(run.graph.checkpointSeq || 0) <= 0) {
    return notApplicable(id);
  }
  const refs = [
    { label: "Run record", path: "run_record.json" },
    { label: "Latest checkpoint", path: "checkpoints/latest.json" }
  ];
  return issues.length === 0
    ? check(id, "pass", true, [], refs)
    : check(id, "fail", true, [...new Set(issues.map((issue) => issue.code))], refs);
}

function nodeStarted(run: RunRecord, node: GraphNodeId): boolean {
  const nodeStatus = run.graph.nodeStates[node]?.status;
  if (nodeStatus && nodeStatus !== "pending") {
    return true;
  }
  return GRAPH_NODE_ORDER.indexOf(run.currentNode) >= GRAPH_NODE_ORDER.indexOf(node);
}

function notApplicable(
  id: RunResearchProcessCheckProjection["id"]
): RunResearchProcessCheckProjection {
  return check(id, "not_applicable", false, [], []);
}

function check(
  id: RunResearchProcessCheckProjection["id"],
  status: RunResearchProcessCheckProjection["status"],
  required: boolean,
  reasonCodes: string[],
  artifactRefs: RunResearchProcessCheckProjection["artifact_refs"]
): RunResearchProcessCheckProjection {
  return {
    id,
    status,
    required,
    reason_codes: [...new Set(reasonCodes.filter(Boolean))],
    artifact_refs: artifactRefs
  };
}

async function readJson(filePath: string): Promise<JsonRead> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed)
      ? { status: "available", value: parsed }
      : { status: "malformed" };
  } catch (error) {
    return isEnoent(error) ? { status: "missing" } : { status: "malformed" };
  }
}

function refsForAvailable(
  entries: Array<[JsonRead, { label: string; path: string }]>
): Array<{ label: string; path: string }> {
  return entries
    .filter(([artifact]) => artifact.status !== "missing")
    .map(([, ref]) => ref);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function textValue(value: unknown): string | undefined {
  return nonEmptyString(value) ? value.trim() : undefined;
}

function toReasonCode(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96);
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
