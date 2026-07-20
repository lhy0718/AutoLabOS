import { createHash } from "node:crypto";

import type { GateFinding, GovernedResearchNode } from "./researchGovernanceArtifacts.js";

export const MODEL_REVIEW_BUNDLE_SCHEMA_VERSION = "1.0" as const;

export const REQUIRED_MODEL_REVIEW_ROLES = [
  "claim_evidence",
  "methodology",
  "statistics",
  "reproducibility",
  "adversarial"
] as const;

export type ModelReviewRole = typeof REQUIRED_MODEL_REVIEW_ROLES[number];

export interface ModelReviewGateBinding {
  artifact_id: string;
  sha256: string;
}

export interface ModelReviewPolicy {
  consensus_is_evidence: false;
  may_override_deterministic_gate: false;
  may_create_external_evidence: false;
}

export interface ModelReviewerProvenance {
  actor: "model";
  provider: string;
  model: string;
  reasoning_effort: string;
  execution_id: string;
  context_isolated: true;
  input_sha256: string;
  output_sha256: string;
}

export interface ModelSpecialistReview {
  reviewer_id: string;
  role: ModelReviewRole;
  provenance: ModelReviewerProvenance;
  findings: GateFinding[];
}

export interface ModelReviewAdjudicator {
  reviewer_id: string;
  role: "meta_reviewer";
  provenance: ModelReviewerProvenance;
  findings: GateFinding[];
}

export interface ModelReviewBundle {
  schema_version: typeof MODEL_REVIEW_BUNDLE_SCHEMA_VERSION;
  artifact_type: "ModelReviewBundle";
  gate_report: ModelReviewGateBinding;
  policy: ModelReviewPolicy;
  reviewers: ModelSpecialistReview[];
  adjudicator: ModelReviewAdjudicator;
}

export type ModelReviewBundleValidationIssueCode =
  | "invalid_shape"
  | "unsupported_version"
  | "missing_role"
  | "reviewer_role_conflict"
  | "reviewer_identity_conflict"
  | "execution_context_conflict"
  | "policy_violation"
  | "gate_binding_mismatch"
  | "output_binding_mismatch"
  | "adjudicator_input_binding_mismatch";

export interface ModelReviewBundleValidationIssue {
  code: ModelReviewBundleValidationIssueCode;
  path: string;
  message: string;
}

export interface ModelReviewBundleValidationResult {
  ok: boolean;
  issues: ModelReviewBundleValidationIssue[];
}

const MODEL_REVIEW_ROLES = new Set<string>(REQUIRED_MODEL_REVIEW_ROLES);
const GOVERNED_RESEARCH_NODES = new Set<GovernedResearchNode>([
  "collect_papers",
  "analyze_papers",
  "generate_hypotheses",
  "design_experiments",
  "implement_experiments",
  "run_experiments",
  "analyze_results",
  "figure_audit",
  "review",
  "write_paper"
]);
const FINDING_SURFACES = new Set(["prompt", "validator", "skill"]);

export function validateModelReviewBundle(
  value: unknown,
  expectedGate?: Readonly<ModelReviewGateBinding>
): ModelReviewBundleValidationResult {
  const issues: ModelReviewBundleValidationIssue[] = [];
  if (!isRecord(value)) {
    return {
      ok: false,
      issues: [{
        code: "invalid_shape",
        path: "$",
        message: "ModelReviewBundle must be a JSON object."
      }]
    };
  }

  requireExactKeys(value, [
    "schema_version",
    "artifact_type",
    "gate_report",
    "policy",
    "reviewers",
    "adjudicator"
  ], "$", issues);
  if (value.schema_version !== MODEL_REVIEW_BUNDLE_SCHEMA_VERSION) {
    issues.push({
      code: "unsupported_version",
      path: "$.schema_version",
      message: `Expected ModelReviewBundle schema version ${MODEL_REVIEW_BUNDLE_SCHEMA_VERSION}.`
    });
  }
  if (value.artifact_type !== "ModelReviewBundle") {
    issues.push({
      code: "invalid_shape",
      path: "$.artifact_type",
      message: "artifact_type must be ModelReviewBundle."
    });
  }

  validateGateBinding(value.gate_report, expectedGate, issues);
  validatePolicy(value.policy, issues);

  const reviewers = Array.isArray(value.reviewers) ? value.reviewers : [];
  if (!Array.isArray(value.reviewers)
      || reviewers.length < REQUIRED_MODEL_REVIEW_ROLES.length
      || reviewers.length > 32) {
    issues.push({
      code: "invalid_shape",
      path: "$.reviewers",
      message: `reviewers must contain between ${REQUIRED_MODEL_REVIEW_ROLES.length} and 32 specialist reviews.`
    });
  }
  reviewers.forEach((reviewer, index) => validateSpecialistReview(reviewer, index, issues));
  validateAdjudicator(value.adjudicator, issues);
  validatePanelIndependence(reviewers, value.adjudicator, issues);
  validateAdjudicatorInputBinding(value.gate_report, reviewers, value.adjudicator, issues);

  const observedRoles = new Map<string, string>();
  reviewers.forEach((reviewer, index) => {
    if (!isRecord(reviewer) || typeof reviewer.role !== "string") return;
    const currentPath = `$.reviewers[${index}].role`;
    const previousPath = observedRoles.get(reviewer.role);
    if (previousPath) {
      issues.push({
        code: "reviewer_role_conflict",
        path: currentPath,
        message: `Specialist role must differ from ${previousPath}.`
      });
    } else {
      observedRoles.set(reviewer.role, currentPath);
    }
  });
  for (const role of REQUIRED_MODEL_REVIEW_ROLES) {
    if (!observedRoles.has(role)) {
      issues.push({
        code: "missing_role",
        path: "$.reviewers",
        message: `ModelReviewBundle requires a ${role} specialist.`
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

export function parseModelReviewBundle(
  value: unknown,
  expectedGate?: Readonly<ModelReviewGateBinding>
): ModelReviewBundle {
  const validation = validateModelReviewBundle(value, expectedGate);
  if (!validation.ok) {
    throw new Error(
      `Invalid ModelReviewBundle: ${validation.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join("; ")}`
    );
  }

  const record = value as Record<string, unknown>;
  const gateReport = record.gate_report as Record<string, unknown>;
  const reviewers = record.reviewers as Array<Record<string, unknown>>;
  return {
    schema_version: MODEL_REVIEW_BUNDLE_SCHEMA_VERSION,
    artifact_type: "ModelReviewBundle",
    gate_report: {
      artifact_id: gateReport.artifact_id as string,
      sha256: gateReport.sha256 as string
    },
    policy: {
      consensus_is_evidence: false,
      may_override_deterministic_gate: false,
      may_create_external_evidence: false
    },
    reviewers: reviewers.map((reviewer) => normalizeSpecialistReview(reviewer)),
    adjudicator: normalizeAdjudicator(record.adjudicator as Record<string, unknown>)
  };
}

export function collectModelReviewFindings(bundle: ModelReviewBundle): GateFinding[] {
  return [
    ...bundle.reviewers.flatMap((reviewer) => reviewer.findings),
    ...bundle.adjudicator.findings
  ].map(cloneFinding);
}

export function hashModelReviewBundle(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hashModelReviewOutput(
  review: Pick<ModelSpecialistReview, "reviewer_id" | "role" | "findings">
    | Pick<ModelReviewAdjudicator, "reviewer_id" | "role" | "findings">
): string {
  return hashCanonicalJson({
    reviewer_id: review.reviewer_id,
    role: review.role,
    findings: review.findings.map(normalizeFindingForHash)
  });
}

export function hashModelReviewAdjudicatorInput(
  gateReport: Readonly<ModelReviewGateBinding>,
  reviewers: readonly Pick<ModelSpecialistReview, "role" | "provenance">[]
): string {
  const roleOrder = new Map<string, number>(
    REQUIRED_MODEL_REVIEW_ROLES.map((role, index) => [role, index])
  );
  const specialistOutputs = [...reviewers]
    .sort((left, right) => (roleOrder.get(left.role) ?? 999) - (roleOrder.get(right.role) ?? 999))
    .map((reviewer) => ({
      role: reviewer.role,
      output_sha256: reviewer.provenance.output_sha256
    }));
  return hashCanonicalJson({ gate_report: gateReport, specialist_outputs: specialistOutputs });
}

function validateGateBinding(
  value: unknown,
  expectedGate: Readonly<ModelReviewGateBinding> | undefined,
  issues: ModelReviewBundleValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({
      code: "invalid_shape",
      path: "$.gate_report",
      message: "gate_report must bind an artifact_id and sha256."
    });
    return;
  }
  requireExactKeys(value, ["artifact_id", "sha256"], "$.gate_report", issues);
  if (!validIdentifier(value.artifact_id)) {
    issues.push({
      code: "invalid_shape",
      path: "$.gate_report.artifact_id",
      message: "gate_report.artifact_id must be a non-empty portable identifier."
    });
  }
  if (!sha256String(value.sha256)) {
    issues.push({
      code: "invalid_shape",
      path: "$.gate_report.sha256",
      message: "gate_report.sha256 must be a lowercase SHA-256 digest."
    });
  }
  if (expectedGate && value.artifact_id !== expectedGate.artifact_id) {
    issues.push({
      code: "gate_binding_mismatch",
      path: "$.gate_report.artifact_id",
      message: "ModelReviewBundle does not reference the supplied GateReport artifact_id."
    });
  }
  if (expectedGate && value.sha256 !== expectedGate.sha256) {
    issues.push({
      code: "gate_binding_mismatch",
      path: "$.gate_report.sha256",
      message: "ModelReviewBundle does not match the supplied GateReport bytes."
    });
  }
}

function validatePolicy(
  value: unknown,
  issues: ModelReviewBundleValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({
      code: "invalid_shape",
      path: "$.policy",
      message: "ModelReviewBundle policy is required."
    });
    return;
  }
  const fields = [
    "consensus_is_evidence",
    "may_override_deterministic_gate",
    "may_create_external_evidence"
  ] as const;
  requireExactKeys(value, fields, "$.policy", issues);
  for (const field of fields) {
    if (value[field] !== false) {
      issues.push({
        code: "policy_violation",
        path: `$.policy.${field}`,
        message: `${field} must be literal false.`
      });
    }
  }
}

function validateSpecialistReview(
  value: unknown,
  index: number,
  issues: ModelReviewBundleValidationIssue[]
): void {
  const currentPath = `$.reviewers[${index}]`;
  if (!isRecord(value)) {
    issues.push({ code: "invalid_shape", path: currentPath, message: "Specialist review must be an object." });
    return;
  }
  requireExactKeys(value, ["reviewer_id", "role", "provenance", "findings"], currentPath, issues);
  if (!validIdentifier(value.reviewer_id)) {
    issues.push({ code: "invalid_shape", path: `${currentPath}.reviewer_id`, message: "reviewer_id is invalid." });
  }
  if (typeof value.role !== "string" || !MODEL_REVIEW_ROLES.has(value.role)) {
    issues.push({
      code: "invalid_shape",
      path: `${currentPath}.role`,
      message: "Specialist role is not supported by this protocol version."
    });
  }
  validateReviewerProvenance(value.provenance, `${currentPath}.provenance`, issues);
  validateFindings(value.findings, `${currentPath}.findings`, issues);
  validateOutputBinding(value, currentPath, issues);
}

function validateAdjudicator(
  value: unknown,
  issues: ModelReviewBundleValidationIssue[]
): void {
  const currentPath = "$.adjudicator";
  if (!isRecord(value)) {
    issues.push({ code: "invalid_shape", path: currentPath, message: "A separate meta-reviewer is required." });
    return;
  }
  requireExactKeys(value, ["reviewer_id", "role", "provenance", "findings"], currentPath, issues);
  if (!validIdentifier(value.reviewer_id)) {
    issues.push({ code: "invalid_shape", path: `${currentPath}.reviewer_id`, message: "reviewer_id is invalid." });
  }
  if (value.role !== "meta_reviewer") {
    issues.push({
      code: "invalid_shape",
      path: `${currentPath}.role`,
      message: "The adjudicator role must be meta_reviewer."
    });
  }
  validateReviewerProvenance(value.provenance, `${currentPath}.provenance`, issues);
  validateFindings(value.findings, `${currentPath}.findings`, issues);
  validateOutputBinding(value, currentPath, issues);
}

function validateOutputBinding(
  value: Record<string, unknown>,
  currentPath: string,
  issues: ModelReviewBundleValidationIssue[]
): void {
  if (!validIdentifier(value.reviewer_id)
      || typeof value.role !== "string"
      || !Array.isArray(value.findings)
      || !value.findings.every(isHashableFinding)
      || !isRecord(value.provenance)
      || !sha256String(value.provenance.output_sha256)) {
    return;
  }
  const expected = hashModelReviewOutput({
    reviewer_id: value.reviewer_id,
    role: value.role as ModelReviewRole | "meta_reviewer",
    findings: value.findings as GateFinding[]
  });
  if (value.provenance.output_sha256 !== expected) {
    issues.push({
      code: "output_binding_mismatch",
      path: `${currentPath}.provenance.output_sha256`,
      message: "output_sha256 does not bind the normalized reviewer identity, role, and findings."
    });
  }
}

function validateAdjudicatorInputBinding(
  gateReport: unknown,
  reviewers: unknown[],
  adjudicator: unknown,
  issues: ModelReviewBundleValidationIssue[]
): void {
  if (!isRecord(gateReport)
      || !validIdentifier(gateReport.artifact_id)
      || !sha256String(gateReport.sha256)
      || !isRecord(adjudicator)
      || !isRecord(adjudicator.provenance)
      || !sha256String(adjudicator.provenance.input_sha256)) {
    return;
  }
  const specialistBindings = reviewers.flatMap((reviewer) => {
    if (!isRecord(reviewer)
        || typeof reviewer.role !== "string"
        || !MODEL_REVIEW_ROLES.has(reviewer.role)
        || !isRecord(reviewer.provenance)
        || !sha256String(reviewer.provenance.output_sha256)) {
      return [];
    }
    return [{
      role: reviewer.role as ModelReviewRole,
      provenance: { output_sha256: reviewer.provenance.output_sha256 }
    }];
  });
  if (specialistBindings.length !== REQUIRED_MODEL_REVIEW_ROLES.length) return;
  const expected = hashModelReviewAdjudicatorInput(
    { artifact_id: gateReport.artifact_id, sha256: gateReport.sha256 },
    specialistBindings as Pick<ModelSpecialistReview, "role" | "provenance">[]
  );
  if (adjudicator.provenance.input_sha256 !== expected) {
    issues.push({
      code: "adjudicator_input_binding_mismatch",
      path: "$.adjudicator.provenance.input_sha256",
      message: "The adjudicator input hash must bind the gate and the ordered specialist output hashes."
    });
  }
}

function validateReviewerProvenance(
  value: unknown,
  currentPath: string,
  issues: ModelReviewBundleValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ code: "invalid_shape", path: currentPath, message: "Model reviewer provenance is required." });
    return;
  }
  requireExactKeys(value, [
    "actor",
    "provider",
    "model",
    "reasoning_effort",
    "execution_id",
    "context_isolated",
    "input_sha256",
    "output_sha256"
  ], currentPath, issues);
  if (value.actor !== "model") {
    issues.push({ code: "invalid_shape", path: `${currentPath}.actor`, message: "actor must be model." });
  }
  for (const field of ["provider", "model", "reasoning_effort"] as const) {
    if (!boundedText(value[field], 256)) {
      issues.push({ code: "invalid_shape", path: `${currentPath}.${field}`, message: `${field} must be non-empty text.` });
    }
  }
  if (!validIdentifier(value.execution_id)) {
    issues.push({ code: "invalid_shape", path: `${currentPath}.execution_id`, message: "execution_id is invalid." });
  }
  if (value.context_isolated !== true) {
    issues.push({
      code: "execution_context_conflict",
      path: `${currentPath}.context_isolated`,
      message: "Every model reviewer must attest context_isolated=true."
    });
  }
  for (const field of ["input_sha256", "output_sha256"] as const) {
    if (!sha256String(value[field])) {
      issues.push({
        code: "invalid_shape",
        path: `${currentPath}.${field}`,
        message: `${field} must be a lowercase SHA-256 digest.`
      });
    }
  }
}

function validateFindings(
  value: unknown,
  currentPath: string,
  issues: ModelReviewBundleValidationIssue[]
): void {
  if (!Array.isArray(value) || value.length > 256) {
    issues.push({
      code: "invalid_shape",
      path: currentPath,
      message: "findings must be an array with at most 256 entries."
    });
    return;
  }
  value.forEach((finding, index) => validateFinding(finding, `${currentPath}[${index}]`, issues));
}

function validateFinding(
  value: unknown,
  currentPath: string,
  issues: ModelReviewBundleValidationIssue[]
): void {
  if (!isRecord(value)) {
    issues.push({ code: "invalid_shape", path: currentPath, message: "Finding must be an object." });
    return;
  }
  requireAllowedKeys(
    value,
    ["code", "severity", "message", "evidence_refs"],
    ["target_node", "target_surface", "recheck_condition"],
    currentPath,
    issues
  );
  if (typeof value.code !== "string" || !/^[a-z0-9][a-z0-9._:-]{0,255}$/u.test(value.code)) {
    issues.push({ code: "invalid_shape", path: `${currentPath}.code`, message: "Finding code is invalid." });
  }
  if (value.severity !== "blocker" && value.severity !== "warning") {
    issues.push({
      code: "invalid_shape",
      path: `${currentPath}.severity`,
      message: "Finding severity must be blocker or warning."
    });
  }
  if (!boundedText(value.message, 8000)) {
    issues.push({ code: "invalid_shape", path: `${currentPath}.message`, message: "Finding message is invalid." });
  }
  if (!Array.isArray(value.evidence_refs)
      || value.evidence_refs.length > 64
      || new Set(value.evidence_refs).size !== value.evidence_refs.length
      || !value.evidence_refs.every(validArtifactReference)) {
    issues.push({
      code: "invalid_shape",
      path: `${currentPath}.evidence_refs`,
      message: "Finding evidence_refs must be unique portable artifact references."
    });
  }
  if ("target_node" in value
      && (typeof value.target_node !== "string"
        || !GOVERNED_RESEARCH_NODES.has(value.target_node as GovernedResearchNode))) {
    issues.push({ code: "invalid_shape", path: `${currentPath}.target_node`, message: "target_node is invalid." });
  }
  if ("target_surface" in value
      && (typeof value.target_surface !== "string" || !FINDING_SURFACES.has(value.target_surface))) {
    issues.push({ code: "invalid_shape", path: `${currentPath}.target_surface`, message: "target_surface is invalid." });
  }
  if ("recheck_condition" in value && !boundedText(value.recheck_condition, 4000)) {
    issues.push({
      code: "invalid_shape",
      path: `${currentPath}.recheck_condition`,
      message: "recheck_condition is invalid."
    });
  }
}

function validatePanelIndependence(
  reviewers: unknown[],
  adjudicator: unknown,
  issues: ModelReviewBundleValidationIssue[]
): void {
  const participants = [
    ...reviewers.map((reviewer, index) => ({ reviewer, path: `$.reviewers[${index}]` })),
    { reviewer: adjudicator, path: "$.adjudicator" }
  ].filter((entry): entry is { reviewer: Record<string, unknown>; path: string } => isRecord(entry.reviewer));
  const reviewerIds = new Map<string, string>();
  const executionIds = new Map<string, string>();
  for (const participant of participants) {
    const reviewerId = participant.reviewer.reviewer_id;
    if (typeof reviewerId === "string") {
      const previousPath = reviewerIds.get(reviewerId);
      if (previousPath) {
        issues.push({
          code: "reviewer_identity_conflict",
          path: `${participant.path}.reviewer_id`,
          message: `reviewer_id must differ from ${previousPath}.`
        });
      } else {
        reviewerIds.set(reviewerId, `${participant.path}.reviewer_id`);
      }
    }
    const provenance = participant.reviewer.provenance;
    const executionId = isRecord(provenance) ? provenance.execution_id : undefined;
    if (typeof executionId === "string") {
      const previousPath = executionIds.get(executionId);
      if (previousPath) {
        issues.push({
          code: "execution_context_conflict",
          path: `${participant.path}.provenance.execution_id`,
          message: `execution_id must differ from ${previousPath}.`
        });
      } else {
        executionIds.set(executionId, `${participant.path}.provenance.execution_id`);
      }
    }
  }
}

function normalizeSpecialistReview(value: Record<string, unknown>): ModelSpecialistReview {
  return {
    reviewer_id: value.reviewer_id as string,
    role: value.role as ModelReviewRole,
    provenance: normalizeProvenance(value.provenance as Record<string, unknown>),
    findings: (value.findings as Array<Record<string, unknown>>).map(normalizeFinding)
  };
}

function normalizeAdjudicator(value: Record<string, unknown>): ModelReviewAdjudicator {
  return {
    reviewer_id: value.reviewer_id as string,
    role: "meta_reviewer",
    provenance: normalizeProvenance(value.provenance as Record<string, unknown>),
    findings: (value.findings as Array<Record<string, unknown>>).map(normalizeFinding)
  };
}

function normalizeProvenance(value: Record<string, unknown>): ModelReviewerProvenance {
  return {
    actor: "model",
    provider: (value.provider as string).trim(),
    model: (value.model as string).trim(),
    reasoning_effort: (value.reasoning_effort as string).trim(),
    execution_id: value.execution_id as string,
    context_isolated: true,
    input_sha256: value.input_sha256 as string,
    output_sha256: value.output_sha256 as string
  };
}

function normalizeFinding(value: Record<string, unknown>): GateFinding {
  return {
    code: value.code as string,
    severity: value.severity as GateFinding["severity"],
    message: (value.message as string).trim(),
    evidence_refs: [...value.evidence_refs as string[]],
    ...(typeof value.target_node === "string" ? { target_node: value.target_node as GovernedResearchNode } : {}),
    ...(typeof value.target_surface === "string"
      ? { target_surface: value.target_surface as GateFinding["target_surface"] }
      : {}),
    ...(typeof value.recheck_condition === "string"
      ? { recheck_condition: value.recheck_condition.trim() }
      : {})
  };
}

function normalizeFindingForHash(finding: GateFinding): GateFinding {
  return {
    code: finding.code,
    severity: finding.severity,
    message: finding.message.trim(),
    evidence_refs: [...finding.evidence_refs],
    ...(finding.target_node ? { target_node: finding.target_node } : {}),
    ...(finding.target_surface ? { target_surface: finding.target_surface } : {}),
    ...(finding.recheck_condition
      ? { recheck_condition: finding.recheck_condition.trim() }
      : {})
  };
}

function isHashableFinding(value: unknown): value is GateFinding {
  return isRecord(value)
    && typeof value.code === "string"
    && (value.severity === "blocker" || value.severity === "warning")
    && typeof value.message === "string"
    && Array.isArray(value.evidence_refs)
    && value.evidence_refs.every((item) => typeof item === "string")
    && (!("target_node" in value) || typeof value.target_node === "string")
    && (!("target_surface" in value) || typeof value.target_surface === "string")
    && (!("recheck_condition" in value) || typeof value.recheck_condition === "string");
}

function cloneFinding(finding: GateFinding): GateFinding {
  return {
    ...finding,
    evidence_refs: [...finding.evidence_refs]
  };
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  currentPath: string,
  issues: ModelReviewBundleValidationIssue[]
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.join("\0") !== required.join("\0")) {
    issues.push({
      code: "invalid_shape",
      path: currentPath,
      message: `Expected exactly these fields: ${required.join(", ")}.`
    });
  }
}

function requireAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  currentPath: string,
  issues: ModelReviewBundleValidationIssue[]
): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((field) => !(field in value)) || Object.keys(value).some((field) => !allowed.has(field))) {
    issues.push({
      code: "invalid_shape",
      path: currentPath,
      message: `Finding fields must be limited to: ${[...required, ...optional].join(", ")}.`
    });
  }
}

function validArtifactReference(value: unknown): value is string {
  if (!boundedText(value, 2048)
      || value.startsWith("/")
      || /^[A-Za-z]:[\\/]/u.test(value)
      || /^[a-z][a-z0-9+.-]*:\/\//iu.test(value)
      || value.includes("\\")) {
    return false;
  }
  return !value.split("/").some((segment) => segment === "..");
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

function sha256String(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= maxLength
    && !value.includes("\0");
}

function hashCanonicalJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
