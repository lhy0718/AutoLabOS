import { createHash } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../utils/fs.js";
import { verifyResearchValidationReport } from "./researchValidationRun.js";

export const RESEARCH_MILESTONE_ASSERTION_OPERATORS = [
  "equals",
  "not_equals",
  "gte",
  "lte",
  "min_items",
  "max_items",
  "contains",
  "one_of"
] as const;

export type ResearchMilestoneAssertionOperator = typeof RESEARCH_MILESTONE_ASSERTION_OPERATORS[number];

export interface ResearchMilestoneAssertion {
  pointer: string;
  operator: ResearchMilestoneAssertionOperator;
  expected: unknown;
}

export type ResearchMilestoneEvidenceVerifier = "sha256" | "research_validation_report";

export interface ResearchMilestoneEvidenceContract {
  path: string;
  sha256: string | null;
  verifier?: ResearchMilestoneEvidenceVerifier;
  assertions?: ResearchMilestoneAssertion[];
}

export interface ResearchMilestoneRequirementContract {
  id: string;
  label: string;
  target_node: string;
  required: true;
  evidence: ResearchMilestoneEvidenceContract[];
}

export interface ResearchMilestoneContract {
  schema_version: "1.0";
  milestone_id: string;
  target_state: string;
  evidence_root: string;
  requirements: ResearchMilestoneRequirementContract[];
}

export interface ResearchMilestoneAssertionResult extends ResearchMilestoneAssertion {
  passed: boolean;
  actual: unknown;
  detail: string;
}

export interface ResearchMilestoneEvidenceResult {
  path: string;
  expected_sha256: string | null;
  actual_sha256: string | null;
  verifier: ResearchMilestoneEvidenceVerifier;
  passed: boolean;
  issues: string[];
  assertions: ResearchMilestoneAssertionResult[];
}

export interface ResearchMilestoneRequirementResult {
  id: string;
  label: string;
  target_node: string;
  required: true;
  passed: boolean;
  evidence: ResearchMilestoneEvidenceResult[];
}

export interface ResearchMilestoneNextAction {
  target_node: string;
  requirement_ids: string[];
  labels: string[];
}

export interface ResearchMilestoneAuditReport {
  schema_version: "1.0";
  generated_at: string;
  milestone_id: string;
  target_state: string;
  verdict: "achieved" | "incomplete" | "invalid_contract";
  achieved: boolean;
  contract: {
    ref: string;
    sha256: string;
    evidence_root: string;
  };
  summary: {
    requirement_count: number;
    passed_requirement_count: number;
    failed_requirement_count: number;
  };
  contract_issues: string[];
  requirements: ResearchMilestoneRequirementResult[];
  next_actions: ResearchMilestoneNextAction[];
  evidence_boundary: string;
}

export interface VerifyResearchMilestoneInput {
  cwd: string;
  contractPath: string;
  outDir: string;
}

export interface VerifyResearchMilestoneResult {
  report: ResearchMilestoneAuditReport;
  report_path: string;
  summary_path: string;
}

export async function verifyResearchMilestone(
  input: VerifyResearchMilestoneInput
): Promise<VerifyResearchMilestoneResult> {
  const cwd = path.resolve(input.cwd);
  const contractPath = await resolveContainedRegularFile(cwd, path.resolve(cwd, input.contractPath));
  const outDir = path.resolve(cwd, input.outDir);
  assertStrictlyInside(cwd, outDir, "Milestone audit output");
  await assertNoSymlinkedExistingAncestor(cwd, outDir);
  await assertFreshOutput(outDir);
  await fs.mkdir(outDir, { recursive: true });

  const contractBytes = await fs.readFile(contractPath);
  const contractSha256 = sha256(contractBytes);
  const decoded = decodeJson(contractBytes);
  const { contract, issues: contractIssues } = parseContract(decoded);
  const evidenceRoot = contract
    ? path.resolve(path.dirname(contractPath), contract.evidence_root)
    : path.dirname(contractPath);
  const evidenceRootIssue = await validateEvidenceRoot(cwd, evidenceRoot);
  if (evidenceRootIssue) contractIssues.push(evidenceRootIssue);

  const requirements = contract && contractIssues.length === 0
    ? await Promise.all(contract.requirements.map((requirement) => evaluateRequirement(evidenceRoot, requirement)))
    : [];
  const passedRequirementCount = requirements.filter((requirement) => requirement.passed).length;
  const failedRequirementCount = contract
    ? contract.requirements.length - passedRequirementCount
    : 0;
  const achieved = Boolean(
    contract
    && contractIssues.length === 0
    && requirements.length === contract.requirements.length
    && failedRequirementCount === 0
  );
  const report: ResearchMilestoneAuditReport = {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    milestone_id: contract?.milestone_id || "invalid-contract",
    target_state: contract?.target_state || "unknown",
    verdict: contractIssues.length > 0 ? "invalid_contract" : achieved ? "achieved" : "incomplete",
    achieved,
    contract: {
      ref: portableRef(cwd, contractPath),
      sha256: contractSha256,
      evidence_root: portableRef(cwd, evidenceRoot)
    },
    summary: {
      requirement_count: contract?.requirements.length || 0,
      passed_requirement_count: passedRequirementCount,
      failed_requirement_count: failedRequirementCount
    },
    contract_issues: [...new Set(contractIssues)],
    requirements,
    next_actions: groupNextActions(requirements),
    evidence_boundary: "This audit verifies declared artifact bytes and machine-checkable assertions. It does not independently establish scientific validity, human identity, provider identity, or statistical independence."
  };
  const reportPath = path.join(outDir, "research-milestone-audit.json");
  const summaryPath = path.join(outDir, "research-milestone-audit.md");
  await writeJsonFile(reportPath, report);
  await fs.writeFile(summaryPath, renderSummary(report), "utf8");
  return {
    report,
    report_path: portableRef(cwd, reportPath),
    summary_path: portableRef(cwd, summaryPath)
  };
}

async function evaluateRequirement(
  evidenceRoot: string,
  requirement: ResearchMilestoneRequirementContract
): Promise<ResearchMilestoneRequirementResult> {
  const evidence = await Promise.all(
    requirement.evidence.map((item) => evaluateEvidence(evidenceRoot, item))
  );
  return {
    ...requirement,
    passed: evidence.length > 0 && evidence.every((item) => item.passed),
    evidence
  };
}

async function evaluateEvidence(
  evidenceRoot: string,
  contract: ResearchMilestoneEvidenceContract
): Promise<ResearchMilestoneEvidenceResult> {
  const issues: string[] = [];
  const assertionResults: ResearchMilestoneAssertionResult[] = [];
  let actualSha256: string | null = null;
  let decoded: unknown;
  const candidate = path.resolve(evidenceRoot, contract.path);
  if (!isInside(evidenceRoot, candidate)) {
    issues.push("evidence_path_escaped_root");
  } else {
    try {
      await assertNoSymlinkTraversal(evidenceRoot, candidate);
      const stat = await fs.lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        issues.push("evidence_not_regular_file");
      } else if (stat.size === 0) {
        issues.push("evidence_file_empty");
      } else {
        const bytes = await fs.readFile(candidate);
        actualSha256 = sha256(bytes);
        if (contract.verifier === "research_validation_report") {
          const verification = await verifyResearchValidationReport({
            cwd: evidenceRoot,
            reportPath: contract.path
          });
          if (!verification.passed) {
            issues.push(...verification.issues.map((issue) => `evidence_validation_report_${issue}`));
          }
        } else {
          if (!contract.sha256) {
            issues.push("evidence_hash_unbound");
          } else if (actualSha256 !== contract.sha256) {
            issues.push("evidence_hash_mismatch");
          }
        }
        if ((contract.assertions || []).length > 0) {
          try {
            decoded = decodeJson(bytes);
          } catch {
            issues.push("evidence_json_invalid");
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const code = (error as NodeJS.ErrnoException).code;
      issues.push(message === "symbolic link"
        ? "evidence_symbolic_link"
        : code === "ENOENT" ? "evidence_file_missing" : "evidence_file_unreadable");
    }
  }

  if (decoded !== undefined) {
    for (const assertion of contract.assertions || []) {
      const result = evaluateAssertion(decoded, assertion);
      assertionResults.push(result);
      if (!result.passed) issues.push("evidence_assertion_failed");
    }
  }
  return {
    path: contract.path,
    expected_sha256: contract.sha256,
    actual_sha256: actualSha256,
    verifier: contract.verifier || "sha256",
    passed: issues.length === 0,
    issues: [...new Set(issues)],
    assertions: assertionResults
  };
}

function evaluateAssertion(root: unknown, assertion: ResearchMilestoneAssertion): ResearchMilestoneAssertionResult {
  const resolved = resolveJsonPointer(root, assertion.pointer);
  if (!resolved.found) {
    return { ...assertion, passed: false, actual: null, detail: "JSON pointer does not exist." };
  }
  const actual = resolved.value;
  let passed = false;
  switch (assertion.operator) {
    case "equals":
      passed = deepEqual(actual, assertion.expected);
      break;
    case "not_equals":
      passed = !deepEqual(actual, assertion.expected);
      break;
    case "gte":
      passed = typeof actual === "number" && typeof assertion.expected === "number" && actual >= assertion.expected;
      break;
    case "lte":
      passed = typeof actual === "number" && typeof assertion.expected === "number" && actual <= assertion.expected;
      break;
    case "min_items":
      passed = Array.isArray(actual) && typeof assertion.expected === "number" && actual.length >= assertion.expected;
      break;
    case "max_items":
      passed = Array.isArray(actual) && typeof assertion.expected === "number" && actual.length <= assertion.expected;
      break;
    case "contains":
      passed = typeof actual === "string" && typeof assertion.expected === "string"
        ? actual.includes(assertion.expected)
        : Array.isArray(actual) && actual.some((item) => deepEqual(item, assertion.expected));
      break;
    case "one_of":
      passed = Array.isArray(assertion.expected)
        && assertion.expected.some((item) => deepEqual(actual, item));
      break;
  }
  const reportedActual = assertion.operator === "min_items" || assertion.operator === "max_items"
    ? Array.isArray(actual) ? actual.length : actual
    : actual;
  return {
    ...assertion,
    passed,
    actual: reportedActual,
    detail: passed ? "Assertion passed." : `Assertion ${assertion.operator} failed.`
  };
}

function parseContract(value: unknown): { contract: ResearchMilestoneContract | null; issues: string[] } {
  const issues: string[] = [];
  if (!isRecord(value)) return { contract: null, issues: ["contract_root_invalid"] };
  if (value.schema_version !== "1.0") issues.push("contract_schema_version_invalid");
  const milestoneId = nonEmptyString(value.milestone_id);
  const targetState = nonEmptyString(value.target_state);
  const evidenceRoot = nonEmptyString(value.evidence_root);
  if (!milestoneId) issues.push("contract_milestone_id_invalid");
  if (!targetState) issues.push("contract_target_state_invalid");
  if (!evidenceRoot || path.isAbsolute(evidenceRoot)) issues.push("contract_evidence_root_invalid");
  if (!Array.isArray(value.requirements) || value.requirements.length === 0) {
    issues.push("contract_requirements_invalid");
  }
  const requirements: ResearchMilestoneRequirementContract[] = [];
  const requirementIds = new Set<string>();
  for (const [index, raw] of Array.isArray(value.requirements) ? value.requirements.entries() : []) {
    const parsed = parseRequirement(raw, index, issues);
    if (!parsed) continue;
    if (requirementIds.has(parsed.id)) issues.push(`contract_requirement_id_duplicate:${parsed.id}`);
    requirementIds.add(parsed.id);
    requirements.push(parsed);
  }
  if (!milestoneId || !targetState || !evidenceRoot) return { contract: null, issues };
  return {
    contract: {
      schema_version: "1.0",
      milestone_id: milestoneId,
      target_state: targetState,
      evidence_root: evidenceRoot,
      requirements
    },
    issues
  };
}

function parseRequirement(
  value: unknown,
  index: number,
  issues: string[]
): ResearchMilestoneRequirementContract | null {
  if (!isRecord(value)) {
    issues.push(`contract_requirement_invalid:${index}`);
    return null;
  }
  const id = nonEmptyString(value.id);
  const label = nonEmptyString(value.label);
  const targetNode = nonEmptyString(value.target_node);
  if (!id || !/^[a-z][a-z0-9_-]*$/u.test(id)) issues.push(`contract_requirement_id_invalid:${index}`);
  if (!label) issues.push(`contract_requirement_label_invalid:${index}`);
  if (!targetNode) issues.push(`contract_requirement_target_node_invalid:${index}`);
  if (value.required !== true) issues.push(`contract_requirement_must_be_required:${index}`);
  if (!Array.isArray(value.evidence) || value.evidence.length === 0) {
    issues.push(`contract_requirement_evidence_invalid:${index}`);
  }
  const evidence: ResearchMilestoneEvidenceContract[] = [];
  for (const [evidenceIndex, raw] of Array.isArray(value.evidence) ? value.evidence.entries() : []) {
    const parsed = parseEvidence(raw, index, evidenceIndex, issues);
    if (parsed) evidence.push(parsed);
  }
  if (!id || !label || !targetNode) return null;
  return { id, label, target_node: targetNode, required: true, evidence };
}

function parseEvidence(
  value: unknown,
  requirementIndex: number,
  evidenceIndex: number,
  issues: string[]
): ResearchMilestoneEvidenceContract | null {
  const prefix = `${requirementIndex}:${evidenceIndex}`;
  if (!isRecord(value)) {
    issues.push(`contract_evidence_invalid:${prefix}`);
    return null;
  }
  const evidencePath = nonEmptyString(value.path);
  if (!evidencePath
    || path.isAbsolute(evidencePath)
    || evidencePath.includes("\\")
    || evidencePath.split(/[\\/]/u).includes("..")) {
    issues.push(`contract_evidence_path_invalid:${prefix}`);
  }
  const expectedSha256 = value.sha256 === null
    ? null
    : typeof value.sha256 === "string" && /^[a-f0-9]{64}$/u.test(value.sha256)
      ? value.sha256
      : undefined;
  if (expectedSha256 === undefined) issues.push(`contract_evidence_sha256_invalid:${prefix}`);
  const verifier = value.verifier === undefined || value.verifier === "sha256"
    ? "sha256"
    : value.verifier === "research_validation_report"
      ? "research_validation_report"
      : undefined;
  if (!verifier) issues.push(`contract_evidence_verifier_invalid:${prefix}`);
  if (verifier === "research_validation_report" && expectedSha256 !== null) {
    issues.push(`contract_evidence_verifier_sha256_conflict:${prefix}`);
  }
  const assertions: ResearchMilestoneAssertion[] = [];
  if (value.assertions !== undefined && !Array.isArray(value.assertions)) {
    issues.push(`contract_evidence_assertions_invalid:${prefix}`);
  }
  for (const [assertionIndex, raw] of Array.isArray(value.assertions) ? value.assertions.entries() : []) {
    if (!isRecord(raw)
      || typeof raw.pointer !== "string"
      || !raw.pointer.startsWith("/")
      || !RESEARCH_MILESTONE_ASSERTION_OPERATORS.includes(raw.operator as ResearchMilestoneAssertionOperator)
      || !("expected" in raw)) {
      issues.push(`contract_assertion_invalid:${prefix}:${assertionIndex}`);
      continue;
    }
    const operator = raw.operator as ResearchMilestoneAssertionOperator;
    const expected = raw.expected;
    const numericOperator = operator === "gte" || operator === "lte";
    const itemCountOperator = operator === "min_items" || operator === "max_items";
    const oneOfOperator = operator === "one_of";
    if (numericOperator && (typeof expected !== "number" || !Number.isFinite(expected))) {
      issues.push(`contract_assertion_expected_invalid:${prefix}:${assertionIndex}`);
      continue;
    }
    if (itemCountOperator
      && (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0)) {
      issues.push(`contract_assertion_expected_invalid:${prefix}:${assertionIndex}`);
      continue;
    }
    if (oneOfOperator && (!Array.isArray(expected) || expected.length === 0)) {
      issues.push(`contract_assertion_expected_invalid:${prefix}:${assertionIndex}`);
      continue;
    }
    assertions.push({
      pointer: raw.pointer,
      operator,
      expected
    });
  }
  if (!evidencePath || expectedSha256 === undefined || !verifier) return null;
  return {
    path: evidencePath,
    sha256: expectedSha256,
    ...(verifier !== "sha256" ? { verifier } : {}),
    ...(assertions.length > 0 ? { assertions } : {})
  };
}

function groupNextActions(requirements: ResearchMilestoneRequirementResult[]): ResearchMilestoneNextAction[] {
  const grouped = new Map<string, ResearchMilestoneRequirementResult[]>();
  for (const requirement of requirements.filter((item) => !item.passed)) {
    grouped.set(requirement.target_node, [...(grouped.get(requirement.target_node) || []), requirement]);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([targetNode, items]) => ({
      target_node: targetNode,
      requirement_ids: items.map((item) => item.id),
      labels: items.map((item) => item.label)
    }));
}

function renderSummary(report: ResearchMilestoneAuditReport): string {
  const lines = [
    "# Research Milestone Audit",
    "",
    `- Milestone: ${report.milestone_id}`,
    `- Target state: ${report.target_state}`,
    `- Verdict: ${report.verdict}`,
    `- Requirements: ${report.summary.passed_requirement_count}/${report.summary.requirement_count} passed`,
    `- Contract: ${report.contract.ref}`,
    "",
    "## Requirements",
    ""
  ];
  for (const requirement of report.requirements) {
    lines.push(`- [${requirement.passed ? "x" : " "}] ${requirement.id}: ${requirement.label} (${requirement.target_node})`);
    for (const evidence of requirement.evidence.filter((item) => !item.passed)) {
      lines.push(`  - ${evidence.path}: ${evidence.issues.join(", ") || "assertion_failed"}`);
    }
  }
  if (report.contract_issues.length > 0) {
    lines.push("", "## Contract Issues", "", ...report.contract_issues.map((issue) => `- ${issue}`));
  }
  lines.push("", "## Evidence Boundary", "", report.evidence_boundary, "");
  return `${lines.join("\n")}\n`;
}

async function resolveContainedRegularFile(cwd: string, candidate: string): Promise<string> {
  if (!isInside(cwd, candidate)) throw new Error("Milestone contract must stay inside the workspace.");
  await assertNoSymlinkTraversal(cwd, candidate);
  const stat = await fs.lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error("Milestone contract must be a non-empty regular file.");
  }
  return candidate;
}

async function validateEvidenceRoot(cwd: string, evidenceRoot: string): Promise<string | null> {
  if (!isInside(cwd, evidenceRoot)) return "contract_evidence_root_escaped_workspace";
  try {
    await assertNoSymlinkTraversal(cwd, evidenceRoot);
    const stat = await fs.lstat(evidenceRoot);
    return stat.isDirectory() && !stat.isSymbolicLink()
      ? null
      : "contract_evidence_root_not_directory";
  } catch {
    return "contract_evidence_root_unreadable";
  }
}

async function assertNoSymlinkTraversal(root: string, target: string): Promise<void> {
  if (!isInside(root, target)) throw new Error("path escaped root");
  const relative = path.relative(root, target);
  let current = root;
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink()) throw new Error("symbolic link");
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("symbolic link");
  }
}

async function assertNoSymlinkedExistingAncestor(root: string, target: string): Promise<void> {
  if (!isInside(root, target)) throw new Error("path escaped root");
  const relative = path.relative(root, target);
  let current = root;
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink()) throw new Error("Milestone audit output must not traverse symbolic links.");
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error("Milestone audit output must not traverse symbolic links.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function assertFreshOutput(outDir: string): Promise<void> {
  try {
    await fs.lstat(outDir);
    throw new Error("Milestone audit output must not already exist.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function assertStrictlyInside(root: string, candidate: string, label: string): void {
  if (!isInside(root, candidate) || path.resolve(root) === path.resolve(candidate)) {
    throw new Error(`${label} must stay strictly inside the workspace.`);
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function portableRef(cwd: string, candidate: string): string {
  const relative = path.relative(cwd, candidate).split(path.sep).join("/");
  return relative || ".";
}

function decodeJson(bytes: Buffer): unknown {
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

function resolveJsonPointer(root: unknown, pointer: string): { found: boolean; value: unknown } {
  let current = root;
  for (const raw of pointer.slice(1).split("/")) {
    const part = raw.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (Array.isArray(current)) {
      if (!/^\d+$/u.test(part)) return { found: false, value: undefined };
      const index = Number(part);
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[index];
    } else if (isRecord(current) && Object.prototype.hasOwnProperty.call(current, part)) {
      current = current[part];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: current };
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
