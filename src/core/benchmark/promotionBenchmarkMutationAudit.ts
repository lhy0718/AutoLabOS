import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import {
  hashPromotionArtifactTree,
  loadPromotionBenchmarkSuite,
  type PromotionBenchmarkCaseManifest
} from "./promotionBenchmark.js";
import type { PromotionMutationManifest, PromotionMutationOperation } from "./promotionBenchmarkBuilder.js";

export const MUTATION_ISOLATION_DECISIONS = ["isolated", "confounded"] as const;

export type PromotionMutationIsolationDecision = typeof MUTATION_ISOLATION_DECISIONS[number];

export interface ExportPromotionMutationAuditPackInput {
  cwd: string;
  suitePath: string;
  outDir: string;
}

export interface ExportPromotionMutationAuditPackResult {
  suite_id: string;
  audit_count: number;
  output_dir: string;
  auditor_dir: string;
  tasks_path: string;
  private_map_path: string;
  rubric_path: string;
}

export interface PromotionMutationAuditRecord {
  schema_version: "1.0";
  audit_id: string;
  auditor_id: string;
  audit_source: "human";
  decision: PromotionMutationIsolationDecision;
  additional_faults: string[];
  rationale: string;
}

interface PromotionMutationAuditMapEntry {
  audit_id: string;
  case_id: string;
  clean_case_id: string;
  mutation_family: string;
  case_manifest_sha256: string;
  clean_case_manifest_sha256: string;
  artifact_sha256: string;
  clean_artifact_sha256: string;
  mutation_manifest_sha256: string;
}

interface PromotionMutationAuditPrivateMap {
  schema_version: "1.0";
  suite_id: string;
  suite_manifest_sha256: string;
  entries: PromotionMutationAuditMapEntry[];
}

export interface PromotionMutationAuditIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface PromotionMutationAuditCaseResult {
  audit_id: string;
  case_id: string;
  decision: PromotionMutationIsolationDecision;
  binding: {
    clean_case_id: string;
    mutation_family: string;
    case_manifest_sha256: string;
    clean_case_manifest_sha256: string;
    artifact_sha256: string;
    clean_artifact_sha256: string;
    mutation_manifest_sha256: string;
  };
  audits: PromotionMutationAuditRecord[];
}

export interface PromotionMutationAuditReport {
  schema_version: "1.0";
  generated_at: string;
  suite_id: string;
  suite_manifest_sha256: string;
  passed: boolean;
  mutation_isolation_status: "unreviewed" | "double_verified";
  auditor_ids: string[];
  case_count: number;
  verified_case_count: number;
  confounded_case_count: number;
  disagreement_count: number;
  validation_issues: PromotionMutationAuditIssue[];
  case_results: PromotionMutationAuditCaseResult[];
}

export interface VerifyPromotionMutationAuditInput {
  cwd: string;
  suitePath: string;
  privateMapPath: string;
  auditPaths: string[];
  outDir: string;
}

export interface VerifyPromotionMutationAuditResult {
  report: PromotionMutationAuditReport;
  output_dir: string;
  report_path: string;
}

export interface ValidateVerifiedMutationAuditReportInput {
  reportPath: string;
  suitePath: string;
  suiteId: string;
  cases: PromotionBenchmarkCaseManifest[];
}

export async function exportPromotionMutationAuditPack(
  input: ExportPromotionMutationAuditPackInput
): Promise<ExportPromotionMutationAuditPackResult> {
  const cwd = path.resolve(input.cwd);
  const suitePath = path.resolve(cwd, input.suitePath);
  const outDir = path.resolve(cwd, input.outDir);
  const loaded = await loadPromotionBenchmarkSuite(suitePath);
  if (!loaded.suite || loaded.issues.length > 0) {
    throw new Error(`Promotion suite is invalid: ${loaded.issues.map((issue) => issue.code).join(", ") || "unreadable"}`);
  }
  if (await pathExists(outDir)) throw new Error(`Promotion mutation audit output already exists: ${portableRef(cwd, outDir)}`);

  const cleanByBase = cleanCasesByBase(loaded.suite.cases);
  const mutatedCases = loaded.suite.cases.filter((benchmarkCase) => benchmarkCase.mutation_family);
  if (mutatedCases.length === 0) throw new Error("Promotion mutation audit requires at least one mutated case.");

  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(path.dirname(outDir), `.${path.basename(outDir)}.tmp-`));
  try {
    const entries: PromotionMutationAuditMapEntry[] = [];
    const tasks: string[] = [];
    const seenAuditIds = new Set<string>();
    for (const benchmarkCase of mutatedCases) {
      const cleanCase = cleanByBase.get(benchmarkCase.base_bundle_id);
      if (!cleanCase) throw new Error(`Mutation case has no unique clean control: ${benchmarkCase.case_id}`);
      const caseIndex = loaded.suite.cases.findIndex((item) => item.case_id === benchmarkCase.case_id);
      const cleanIndex = loaded.suite.cases.findIndex((item) => item.case_id === cleanCase.case_id);
      const caseManifestPath = path.resolve(loaded.suite.suite_root, loaded.suite.manifest.cases[caseIndex]);
      const cleanCaseManifestPath = path.resolve(loaded.suite.suite_root, loaded.suite.manifest.cases[cleanIndex]);
      const mutationManifestPath = resolveMutationManifestPath(caseManifestPath, benchmarkCase);
      const mutationManifest = await readMutationManifest(mutationManifestPath, benchmarkCase.case_id);
      const artifactRoot = loaded.suite.case_artifact_roots[benchmarkCase.case_id];
      const cleanArtifactRoot = loaded.suite.case_artifact_roots[cleanCase.case_id];
      const artifactSha256 = await hashPromotionArtifactTree(artifactRoot);
      const cleanArtifactSha256 = await hashPromotionArtifactTree(cleanArtifactRoot);
      const auditId = opaqueMutationAuditId(loaded.suite.manifest.suite_id, benchmarkCase.case_id, artifactSha256);
      if (seenAuditIds.has(auditId)) throw new Error(`Opaque mutation audit id collision: ${auditId}`);
      seenAuditIds.add(auditId);

      const pairRoot = path.join(stagingRoot, "mutation-auditor", "artifacts", auditId);
      await fs.cp(cleanArtifactRoot, path.join(pairRoot, "clean"), { recursive: true, errorOnExist: true, force: false });
      await fs.cp(artifactRoot, path.join(pairRoot, "mutated"), { recursive: true, errorOnExist: true, force: false });
      tasks.push(JSON.stringify({
        schema_version: "1.0",
        audit_id: auditId,
        mutation_family: benchmarkCase.mutation_family,
        clean_artifact_root: `artifacts/${auditId}/clean`,
        mutated_artifact_root: `artifacts/${auditId}/mutated`,
        declared_operations: mutationManifest.operations.map((record) => record.operation),
        allowed_decisions: MUTATION_ISOLATION_DECISIONS,
        required_output_fields: [
          "schema_version",
          "audit_id",
          "auditor_id",
          "audit_source",
          "decision",
          "additional_faults",
          "rationale"
        ]
      }));
      entries.push({
        audit_id: auditId,
        case_id: benchmarkCase.case_id,
        clean_case_id: cleanCase.case_id,
        mutation_family: benchmarkCase.mutation_family || "",
        case_manifest_sha256: await hashFile(caseManifestPath),
        clean_case_manifest_sha256: await hashFile(cleanCaseManifestPath),
        artifact_sha256: artifactSha256,
        clean_artifact_sha256: cleanArtifactSha256,
        mutation_manifest_sha256: await hashFile(mutationManifestPath)
      });
    }
    const privateMap: PromotionMutationAuditPrivateMap = {
      schema_version: "1.0",
      suite_id: loaded.suite.manifest.suite_id,
      suite_manifest_sha256: await hashFile(suitePath),
      entries
    };
    await fs.writeFile(
      path.join(stagingRoot, "mutation-auditor", "mutation-audit-tasks.jsonl"),
      `${tasks.join("\n")}\n`,
      "utf8"
    );
    await fs.writeFile(path.join(stagingRoot, "mutation-auditor", "RUBRIC.md"), mutationAuditRubric(), "utf8");
    await writeJsonFile(path.join(stagingRoot, "private-mutation-audit-map.json"), privateMap);
    await fs.rename(stagingRoot, outDir);
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    suite_id: loaded.suite.manifest.suite_id,
    audit_count: mutatedCases.length,
    output_dir: portableRef(cwd, outDir),
    auditor_dir: portableRef(cwd, path.join(outDir, "mutation-auditor")),
    tasks_path: portableRef(cwd, path.join(outDir, "mutation-auditor", "mutation-audit-tasks.jsonl")),
    private_map_path: portableRef(cwd, path.join(outDir, "private-mutation-audit-map.json")),
    rubric_path: portableRef(cwd, path.join(outDir, "mutation-auditor", "RUBRIC.md"))
  };
}

export async function verifyPromotionMutationAudit(
  input: VerifyPromotionMutationAuditInput
): Promise<VerifyPromotionMutationAuditResult> {
  const cwd = path.resolve(input.cwd);
  const suitePath = path.resolve(cwd, input.suitePath);
  const privateMapPath = path.resolve(cwd, input.privateMapPath);
  const outDir = path.resolve(cwd, input.outDir);
  if (await pathExists(outDir)) throw new Error(`Promotion mutation audit verification output already exists: ${portableRef(cwd, outDir)}`);
  if (input.auditPaths.length !== 2) throw new Error("Promotion mutation audit verification requires exactly two independent audit files.");

  const loaded = await loadPromotionBenchmarkSuite(suitePath);
  if (!loaded.suite || loaded.issues.length > 0) {
    throw new Error(`Promotion suite is invalid: ${loaded.issues.map((issue) => issue.code).join(", ") || "unreadable"}`);
  }
  const privateMap = parsePrivateMap(JSON.parse(await fs.readFile(privateMapPath, "utf8")) as unknown);
  const issues: PromotionMutationAuditIssue[] = [];
  await validatePrivateMap(
    privateMap,
    loaded.suite.manifest.suite_id,
    suitePath,
    loaded.suite.cases,
    loaded.suite.suite_root,
    loaded.suite.manifest.cases,
    loaded.suite.case_artifact_roots,
    issues
  );
  const auditSets = await Promise.all(input.auditPaths.map(async (auditPath) =>
    readAuditFile(path.resolve(cwd, auditPath), privateMap, issues)));
  const auditorIds = auditSets.map((set) => set.auditor_id).filter(nonEmptyString);
  if (new Set(auditorIds).size !== 2) {
    issues.push({ code: "mutation_auditors_not_independent", message: "Mutation audit files must use two distinct auditor IDs." });
  }

  const caseResults: PromotionMutationAuditCaseResult[] = [];
  for (const entry of privateMap.entries) {
    const left = auditSets[0].records.get(entry.audit_id);
    const right = auditSets[1].records.get(entry.audit_id);
    if (!left || !right) continue;
    caseResults.push({
      audit_id: entry.audit_id,
      case_id: entry.case_id,
      decision: left.decision === "isolated" && right.decision === "isolated" ? "isolated" : "confounded",
      binding: {
        clean_case_id: entry.clean_case_id,
        mutation_family: entry.mutation_family,
        case_manifest_sha256: entry.case_manifest_sha256,
        clean_case_manifest_sha256: entry.clean_case_manifest_sha256,
        artifact_sha256: entry.artifact_sha256,
        clean_artifact_sha256: entry.clean_artifact_sha256,
        mutation_manifest_sha256: entry.mutation_manifest_sha256
      },
      audits: [left, right]
    });
  }
  const confoundedCaseCount = caseResults.filter((result) => result.decision === "confounded").length;
  const verifiedCaseCount = caseResults.filter((result) => result.decision === "isolated").length;
  const disagreementCount = caseResults.filter((result) => result.audits[0].decision !== result.audits[1].decision).length;
  const passed = issues.length === 0
    && caseResults.length === privateMap.entries.length
    && confoundedCaseCount === 0;
  const report: PromotionMutationAuditReport = {
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    suite_id: loaded.suite.manifest.suite_id,
    suite_manifest_sha256: await hashFile(suitePath),
    passed,
    mutation_isolation_status: passed ? "double_verified" : "unreviewed",
    auditor_ids: [...new Set(auditorIds)].sort(),
    case_count: privateMap.entries.length,
    verified_case_count: verifiedCaseCount,
    confounded_case_count: confoundedCaseCount,
    disagreement_count: disagreementCount,
    validation_issues: issues,
    case_results: caseResults
  };

  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(path.dirname(outDir), `.${path.basename(outDir)}.tmp-`));
  try {
    await writeJsonFile(path.join(stagingRoot, "mutation-audit-report.json"), report);
    await writeMutationAuditReviewArtifacts(stagingRoot, report);
    await fs.rename(stagingRoot, outDir);
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    report,
    output_dir: portableRef(cwd, outDir),
    report_path: portableRef(cwd, path.join(outDir, "mutation-audit-report.json"))
  };
}

export async function validateVerifiedPromotionMutationAuditReport(
  input: ValidateVerifiedMutationAuditReportInput
): Promise<{ verified: boolean; issues: PromotionMutationAuditIssue[]; auditor_ids: string[] }> {
  const issues: PromotionMutationAuditIssue[] = [];
  let report: PromotionMutationAuditReport;
  try {
    report = parseReport(JSON.parse(await fs.readFile(path.resolve(input.reportPath), "utf8")) as unknown);
  } catch (error) {
    return {
      verified: false,
      issues: [{ code: "mutation_isolation_report_unreadable", message: error instanceof Error ? error.message : String(error) }],
      auditor_ids: []
    };
  }
  if (report.suite_id !== input.suiteId) {
    issues.push({ code: "mutation_isolation_report_suite_mismatch", message: "Mutation audit report belongs to a different suite." });
  }
  if (report.suite_manifest_sha256 !== await hashFile(path.resolve(input.suitePath))) {
    issues.push({ code: "mutation_isolation_report_hash_mismatch", message: "Suite manifest changed after mutation audit." });
  }
  const loaded = await loadPromotionBenchmarkSuite(path.resolve(input.suitePath));
  if (!loaded.suite || loaded.issues.length > 0) {
    issues.push({
      code: "mutation_isolation_report_suite_invalid",
      message: `Mutation audit suite is no longer valid: ${loaded.issues.map((issue) => issue.code).join(", ") || "unreadable"}.`
    });
  }
  const currentCases = loaded.suite?.cases || input.cases;
  const inputIds = new Set(input.cases.map((benchmarkCase) => benchmarkCase.case_id));
  const currentIds = new Set(currentCases.map((benchmarkCase) => benchmarkCase.case_id));
  if (inputIds.size !== currentIds.size || [...inputIds].some((caseId) => !currentIds.has(caseId))) {
    issues.push({ code: "mutation_isolation_report_input_case_mismatch", message: "Mutation audit validation input does not match the current suite cases." });
  }
  const expectedCases = currentCases.filter((benchmarkCase) => benchmarkCase.mutation_family);
  const expectedIds = new Set(expectedCases.map((benchmarkCase) => benchmarkCase.case_id));
  const resultIds = new Set(report.case_results.map((result) => result.case_id));
  if (report.case_count !== expectedCases.length || report.case_results.length !== expectedCases.length
      || resultIds.size !== report.case_results.length || expectedIds.size !== resultIds.size
      || [...expectedIds].some((caseId) => !resultIds.has(caseId))) {
    issues.push({ code: "mutation_isolation_report_coverage_mismatch", message: "Mutation audit report does not cover every mutated suite case exactly once." });
  }
  if (report.auditor_ids.length !== 2 || new Set(report.auditor_ids).size !== 2) {
    issues.push({ code: "mutation_isolation_report_independence_invalid", message: "Mutation audit report must preserve two independent auditor IDs." });
  }
  if (!report.passed || report.mutation_isolation_status !== "double_verified"
      || report.confounded_case_count !== 0 || report.verified_case_count !== expectedCases.length
      || report.validation_issues.length > 0) {
    issues.push({ code: "mutation_isolation_not_double_verified", message: "Mutation isolation is not double verified for every mutated case." });
  }
  const recomputedVerified = report.case_results.filter((result) => result.decision === "isolated").length;
  const recomputedConfounded = report.case_results.filter((result) => result.decision === "confounded").length;
  const recomputedDisagreements = report.case_results.filter((result) =>
    result.audits.length === 2 && result.audits[0].decision !== result.audits[1].decision).length;
  const tracedAuditorIds = [...new Set(report.case_results.flatMap((result) =>
    result.audits.map((audit) => audit.auditor_id)))].sort();
  if (report.verified_case_count !== recomputedVerified
      || report.confounded_case_count !== recomputedConfounded
      || report.disagreement_count !== recomputedDisagreements
      || !arraysEqual(report.auditor_ids, tracedAuditorIds)) {
    issues.push({ code: "mutation_isolation_report_aggregate_mismatch", message: "Mutation audit report aggregates do not match its case traces." });
  }
  for (const result of report.case_results) {
    if (!expectedIds.has(result.case_id) || result.decision !== "isolated" || result.audits.length !== 2
        || new Set(result.audits.map((audit) => audit.auditor_id)).size !== 2
        || result.audits.some((audit) => audit.audit_id !== result.audit_id || audit.decision !== "isolated")) {
      issues.push({ code: "mutation_isolation_case_trace_invalid", message: "Mutation audit case trace is incomplete or not isolated.", ref: result.case_id });
    }
    if (loaded.suite) {
      await validateReportCaseBinding(result, loaded.suite, issues);
    }
  }
  return { verified: issues.length === 0, issues, auditor_ids: report.auditor_ids };
}

async function validatePrivateMap(
  privateMap: PromotionMutationAuditPrivateMap,
  suiteId: string,
  suitePath: string,
  cases: PromotionBenchmarkCaseManifest[],
  suiteRoot: string,
  caseRefs: string[],
  artifactRoots: Record<string, string>,
  issues: PromotionMutationAuditIssue[]
): Promise<void> {
  if (privateMap.suite_id !== suiteId) {
    issues.push({ code: "mutation_audit_map_suite_mismatch", message: "Private mutation audit map belongs to a different suite." });
  }
  if (privateMap.suite_manifest_sha256 !== await hashFile(suitePath)) {
    issues.push({ code: "mutation_audit_map_hash_mismatch", message: "Suite manifest changed after mutation audit export." });
  }
  const cleanByBase = cleanCasesByBase(cases);
  const caseById = new Map(cases.map((benchmarkCase) => [benchmarkCase.case_id, benchmarkCase]));
  const indexById = new Map(cases.map((benchmarkCase, index) => [benchmarkCase.case_id, index]));
  const expectedIds = new Set(cases.filter((benchmarkCase) => benchmarkCase.mutation_family).map((benchmarkCase) => benchmarkCase.case_id));
  const seenAuditIds = new Set<string>();
  const seenCaseIds = new Set<string>();
  for (const entry of privateMap.entries) {
    if (seenAuditIds.has(entry.audit_id)) issues.push({ code: "mutation_audit_map_duplicate_id", message: "Private mutation audit map contains a duplicate audit ID.", ref: entry.audit_id });
    if (seenCaseIds.has(entry.case_id)) issues.push({ code: "mutation_audit_map_duplicate_case", message: "Private mutation audit map contains a duplicate case ID.", ref: entry.case_id });
    seenAuditIds.add(entry.audit_id);
    seenCaseIds.add(entry.case_id);
    const benchmarkCase = caseById.get(entry.case_id);
    const cleanCase = benchmarkCase ? cleanByBase.get(benchmarkCase.base_bundle_id) : undefined;
    if (!benchmarkCase || !benchmarkCase.mutation_family || !cleanCase || cleanCase.case_id !== entry.clean_case_id
        || benchmarkCase.mutation_family !== entry.mutation_family) {
      issues.push({ code: "mutation_audit_map_case_mismatch", message: "Private mutation audit map does not match suite case pairing.", ref: entry.audit_id });
      continue;
    }
    const caseIndex = indexById.get(benchmarkCase.case_id);
    const cleanIndex = indexById.get(cleanCase.case_id);
    if (caseIndex == null || cleanIndex == null) continue;
    const caseManifestPath = path.resolve(suiteRoot, caseRefs[caseIndex]);
    const cleanManifestPath = path.resolve(suiteRoot, caseRefs[cleanIndex]);
    const mutationManifestPath = resolveMutationManifestPath(caseManifestPath, benchmarkCase);
    if (entry.case_manifest_sha256 !== await hashFile(caseManifestPath)
        || entry.clean_case_manifest_sha256 !== await hashFile(cleanManifestPath)
        || entry.mutation_manifest_sha256 !== await hashFile(mutationManifestPath)) {
      issues.push({ code: "mutation_audit_map_manifest_hash_mismatch", message: "Case or mutation manifest changed after audit export.", ref: entry.audit_id });
    }
    if (entry.artifact_sha256 !== await hashPromotionArtifactTree(artifactRoots[benchmarkCase.case_id])
        || entry.clean_artifact_sha256 !== await hashPromotionArtifactTree(artifactRoots[cleanCase.case_id])) {
      issues.push({ code: "mutation_audit_map_artifact_hash_mismatch", message: "Clean or mutated artifact changed after audit export.", ref: entry.audit_id });
    }
  }
  if (seenCaseIds.size !== expectedIds.size || [...expectedIds].some((caseId) => !seenCaseIds.has(caseId))) {
    issues.push({ code: "mutation_audit_map_coverage_incomplete", message: "Private mutation audit map must cover every mutated suite case exactly once." });
  }
}

async function readAuditFile(
  filePath: string,
  privateMap: PromotionMutationAuditPrivateMap,
  issues: PromotionMutationAuditIssue[]
): Promise<{ auditor_id: string; records: Map<string, PromotionMutationAuditRecord> }> {
  const records = new Map<string, PromotionMutationAuditRecord>();
  const allowedIds = new Set(privateMap.entries.map((entry) => entry.audit_id));
  const auditorIds = new Set<string>();
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    issues.push({ code: "mutation_audit_file_unreadable", message: error instanceof Error ? error.message : String(error), ref: path.basename(filePath) });
    return { auditor_id: "", records };
  }
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    let record: PromotionMutationAuditRecord;
    try {
      record = parseAuditRecord(JSON.parse(line) as unknown, `${path.basename(filePath)}:${index + 1}`);
    } catch (error) {
      issues.push({ code: "mutation_audit_record_invalid", message: error instanceof Error ? error.message : String(error), ref: `${path.basename(filePath)}:${index + 1}` });
      continue;
    }
    auditorIds.add(record.auditor_id);
    if (!allowedIds.has(record.audit_id)) {
      issues.push({ code: "mutation_audit_id_unknown", message: "Mutation audit file contains an unknown audit ID.", ref: record.audit_id });
      continue;
    }
    if (records.has(record.audit_id)) {
      issues.push({ code: "mutation_audit_duplicate_id", message: "Mutation audit file contains a duplicate audit ID.", ref: record.audit_id });
      continue;
    }
    records.set(record.audit_id, record);
  }
  if (auditorIds.size !== 1) {
    issues.push({ code: "mutation_audit_file_identity_invalid", message: "Each mutation audit file must use one stable auditor ID.", ref: path.basename(filePath) });
  }
  if (records.size !== privateMap.entries.length) {
    issues.push({ code: "mutation_audit_coverage_incomplete", message: "Each mutation auditor must label every mutation case exactly once.", ref: path.basename(filePath) });
  }
  return { auditor_id: [...auditorIds][0] || "", records };
}

function parseAuditRecord(value: unknown, ref: string): PromotionMutationAuditRecord {
  if (!isRecord(value) || value.schema_version !== "1.0" || !validId(value.audit_id)
      || !validId(value.auditor_id) || value.audit_source !== "human"
      || !isIsolationDecision(value.decision) || !stringArray(value.additional_faults)
      || !nonEmptyString(value.rationale)) {
    throw new Error(`Invalid mutation audit record at ${ref}.`);
  }
  if (value.decision === "isolated" && value.additional_faults.length > 0) {
    throw new Error(`Isolated mutation audit records cannot list additional faults at ${ref}.`);
  }
  if (value.decision === "confounded" && value.additional_faults.length === 0) {
    throw new Error(`Confounded mutation audit records must name at least one additional fault at ${ref}.`);
  }
  return {
    schema_version: "1.0",
    audit_id: value.audit_id,
    auditor_id: value.auditor_id,
    audit_source: "human",
    decision: value.decision,
    additional_faults: value.additional_faults,
    rationale: value.rationale
  };
}

function parsePrivateMap(value: unknown): PromotionMutationAuditPrivateMap {
  if (!isRecord(value) || value.schema_version !== "1.0" || !validId(value.suite_id)
      || !sha256String(value.suite_manifest_sha256) || !Array.isArray(value.entries)) {
    throw new Error("Invalid private mutation audit map.");
  }
  const entries = value.entries.map((entry, index) => {
    if (!isRecord(entry) || !validId(entry.audit_id) || !validId(entry.case_id) || !validId(entry.clean_case_id)
        || !nonEmptyString(entry.mutation_family) || !sha256String(entry.case_manifest_sha256)
        || !sha256String(entry.clean_case_manifest_sha256) || !sha256String(entry.artifact_sha256)
        || !sha256String(entry.clean_artifact_sha256) || !sha256String(entry.mutation_manifest_sha256)) {
      throw new Error(`Invalid private mutation audit map entry at index ${index + 1}.`);
    }
    return entry as unknown as PromotionMutationAuditMapEntry;
  });
  return {
    schema_version: "1.0",
    suite_id: value.suite_id,
    suite_manifest_sha256: value.suite_manifest_sha256,
    entries
  };
}

function parseReport(value: unknown): PromotionMutationAuditReport {
  if (!isRecord(value) || value.schema_version !== "1.0" || !nonEmptyString(value.generated_at) || !validId(value.suite_id)
      || !sha256String(value.suite_manifest_sha256) || typeof value.passed !== "boolean"
      || (value.mutation_isolation_status !== "unreviewed" && value.mutation_isolation_status !== "double_verified")
      || !stringArray(value.auditor_ids) || !nonNegativeInteger(value.case_count)
      || !nonNegativeInteger(value.verified_case_count) || !nonNegativeInteger(value.confounded_case_count)
      || !nonNegativeInteger(value.disagreement_count) || !Array.isArray(value.validation_issues)
      || !Array.isArray(value.case_results)) {
    throw new Error("Invalid promotion mutation audit report.");
  }
  const validationIssues = value.validation_issues.map((issue, index) => {
    if (!isRecord(issue) || !nonEmptyString(issue.code) || !nonEmptyString(issue.message)
        || (issue.ref !== undefined && !nonEmptyString(issue.ref))) {
      throw new Error(`Invalid mutation audit report issue at index ${index + 1}.`);
    }
    return { code: issue.code, message: issue.message, ...(issue.ref ? { ref: issue.ref } : {}) };
  });
  const caseResults = value.case_results.map((result, index) => {
    if (!isRecord(result) || !validId(result.audit_id) || !validId(result.case_id)
        || !isIsolationDecision(result.decision) || !isRecord(result.binding) || !Array.isArray(result.audits)) {
      throw new Error(`Invalid mutation audit report case result at index ${index + 1}.`);
    }
    const binding = result.binding;
    if (!validId(binding.clean_case_id) || !nonEmptyString(binding.mutation_family)
        || !sha256String(binding.case_manifest_sha256) || !sha256String(binding.clean_case_manifest_sha256)
        || !sha256String(binding.artifact_sha256) || !sha256String(binding.clean_artifact_sha256)
        || !sha256String(binding.mutation_manifest_sha256)) {
      throw new Error(`Invalid mutation audit report case binding at index ${index + 1}.`);
    }
    return {
      audit_id: result.audit_id,
      case_id: result.case_id,
      decision: result.decision,
      binding: {
        clean_case_id: binding.clean_case_id,
        mutation_family: binding.mutation_family,
        case_manifest_sha256: binding.case_manifest_sha256,
        clean_case_manifest_sha256: binding.clean_case_manifest_sha256,
        artifact_sha256: binding.artifact_sha256,
        clean_artifact_sha256: binding.clean_artifact_sha256,
        mutation_manifest_sha256: binding.mutation_manifest_sha256
      },
      audits: result.audits.map((audit, auditIndex) => parseAuditRecord(audit, `report:${index + 1}:${auditIndex + 1}`))
    };
  });
  return {
    schema_version: "1.0",
    generated_at: value.generated_at,
    suite_id: value.suite_id,
    suite_manifest_sha256: value.suite_manifest_sha256,
    passed: value.passed,
    mutation_isolation_status: value.mutation_isolation_status,
    auditor_ids: value.auditor_ids,
    case_count: value.case_count,
    verified_case_count: value.verified_case_count,
    confounded_case_count: value.confounded_case_count,
    disagreement_count: value.disagreement_count,
    validation_issues: validationIssues,
    case_results: caseResults
  };
}

async function validateReportCaseBinding(
  result: PromotionMutationAuditCaseResult,
  suite: NonNullable<Awaited<ReturnType<typeof loadPromotionBenchmarkSuite>>["suite"]>,
  issues: PromotionMutationAuditIssue[]
): Promise<void> {
  const benchmarkCase = suite.cases.find((item) => item.case_id === result.case_id);
  const cleanCase = benchmarkCase
    ? cleanCasesByBase(suite.cases).get(benchmarkCase.base_bundle_id)
    : undefined;
  const caseIndex = benchmarkCase ? suite.cases.findIndex((item) => item.case_id === benchmarkCase.case_id) : -1;
  const cleanIndex = cleanCase ? suite.cases.findIndex((item) => item.case_id === cleanCase.case_id) : -1;
  if (!benchmarkCase || !benchmarkCase.mutation_family || !cleanCase || caseIndex < 0 || cleanIndex < 0) {
    issues.push({ code: "mutation_isolation_case_binding_mismatch", message: "Mutation audit binding no longer has a unique suite pair.", ref: result.case_id });
    return;
  }
  const caseManifestPath = path.resolve(suite.suite_root, suite.manifest.cases[caseIndex]);
  const cleanManifestPath = path.resolve(suite.suite_root, suite.manifest.cases[cleanIndex]);
  const mutationManifestPath = resolveMutationManifestPath(caseManifestPath, benchmarkCase);
  const artifactSha256 = await hashPromotionArtifactTree(suite.case_artifact_roots[benchmarkCase.case_id]);
  const cleanArtifactSha256 = await hashPromotionArtifactTree(suite.case_artifact_roots[cleanCase.case_id]);
  const expectedAuditId = opaqueMutationAuditId(suite.manifest.suite_id, benchmarkCase.case_id, artifactSha256);
  const binding = result.binding;
  if (result.audit_id !== expectedAuditId
      || binding.clean_case_id !== cleanCase.case_id
      || binding.mutation_family !== benchmarkCase.mutation_family
      || binding.case_manifest_sha256 !== await hashFile(caseManifestPath)
      || binding.clean_case_manifest_sha256 !== await hashFile(cleanManifestPath)
      || binding.artifact_sha256 !== artifactSha256
      || binding.clean_artifact_sha256 !== cleanArtifactSha256
      || binding.mutation_manifest_sha256 !== await hashFile(mutationManifestPath)) {
    issues.push({
      code: "mutation_isolation_case_binding_mismatch",
      message: "Mutation audit case binding does not match the current suite manifests and artifacts.",
      ref: result.case_id
    });
  }
}

function cleanCasesByBase(cases: PromotionBenchmarkCaseManifest[]): Map<string, PromotionBenchmarkCaseManifest> {
  const result = new Map<string, PromotionBenchmarkCaseManifest>();
  const duplicateBases = new Set<string>();
  for (const benchmarkCase of cases.filter((item) => !item.mutation_family)) {
    if (result.has(benchmarkCase.base_bundle_id)) duplicateBases.add(benchmarkCase.base_bundle_id);
    result.set(benchmarkCase.base_bundle_id, benchmarkCase);
  }
  for (const baseId of duplicateBases) result.delete(baseId);
  return result;
}

async function readMutationManifest(filePath: string, caseId: string): Promise<PromotionMutationManifest> {
  const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  if (!isRecord(value) || value.schema_version !== "1.0" || value.case_id !== caseId || !Array.isArray(value.operations)) {
    throw new Error(`Invalid mutation manifest for ${caseId}.`);
  }
  const operations = value.operations.map((record, index) => {
    if (!isRecord(record) || !isRecord(record.operation) || !nonNegativeInteger(record.index)
        || (record.before_sha256 !== null && !sha256String(record.before_sha256))
        || (record.after_sha256 !== null && !sha256String(record.after_sha256))) {
      throw new Error(`Invalid mutation record ${index + 1} for ${caseId}.`);
    }
    return {
      index: record.index,
      operation: record.operation as unknown as PromotionMutationOperation,
      before_sha256: record.before_sha256,
      after_sha256: record.after_sha256
    };
  });
  return {
    schema_version: "1.0",
    case_id: value.case_id,
    base_bundle_id: nonEmptyString(value.base_bundle_id) ? value.base_bundle_id : "",
    source_sha256: sha256String(value.source_sha256) ? value.source_sha256 : "",
    artifact_sha256: sha256String(value.artifact_sha256) ? value.artifact_sha256 : "",
    ...(nonEmptyString(value.mutation_family) ? { mutation_family: value.mutation_family } : {}),
    operations
  };
}

function resolveMutationManifestPath(caseManifestPath: string, benchmarkCase: PromotionBenchmarkCaseManifest): string {
  if (!benchmarkCase.mutation_manifest) throw new Error(`Mutation manifest is required: ${benchmarkCase.case_id}`);
  return path.resolve(path.dirname(caseManifestPath), benchmarkCase.mutation_manifest);
}

async function writeMutationAuditReviewArtifacts(outputRoot: string, report: PromotionMutationAuditReport): Promise<void> {
  const diagnostics = [
    ...report.validation_issues.map((issue) => ({
      id: `promotion_mutation_audit:${issue.code}${issue.ref ? `:${issue.ref}` : ""}`,
      severity: "blocking",
      target_node: "review",
      source_node: "review",
      summary: issue.message,
      recheck_condition: `Re-run mutation audit verification and require ${issue.code} to be absent.`,
      ...(issue.ref ? { ref: issue.ref } : {})
    })),
    ...report.case_results.filter((result) => result.decision === "confounded").map((result) => ({
      id: `promotion_mutation_audit:confounded:${result.case_id}`,
      severity: "blocking",
      target_node: "design_experiments",
      source_node: "review",
      summary: "Independent mutation audit found an additional fault beyond the declared mutation family.",
      recheck_condition: "Repair the mutation operator, rebuild the suite, and obtain two isolated judgments.",
      ref: result.case_id
    }))
  ];
  const byNode = new Map<string, typeof diagnostics>();
  for (const diagnostic of diagnostics) {
    byNode.set(diagnostic.target_node, [...(byNode.get(diagnostic.target_node) || []), diagnostic]);
  }
  const recommendations = [...byNode.entries()].map(([node, nodeDiagnostics]) => ({
    node,
    priority: "high",
    diagnostic_ids: nodeDiagnostics.map((diagnostic) => diagnostic.id),
    problem_summary: [...new Set(nodeDiagnostics.map((diagnostic) => diagnostic.summary))].join(" "),
    recheck_condition: [...new Set(nodeDiagnostics.map((diagnostic) => diagnostic.recheck_condition))].join(" ")
  })).sort((left, right) => left.node.localeCompare(right.node));
  const reviewRoot = path.join(outputRoot, "review");
  await writeJsonFile(path.join(reviewRoot, "paper_scale_diagnostics.json"), { diagnostics });
  await writeJsonFile(path.join(reviewRoot, "node_strengthening_recommendations.json"), { recommendations });
  await writeJsonFile(path.join(reviewRoot, "decision.json"), {
    outcome: report.passed ? "accept" : "revise",
    mutation_isolation_status: report.mutation_isolation_status,
    diagnostic_count: diagnostics.length
  });
}

function mutationAuditRubric(): string {
  return [
    "# Mutation Isolation Audit Rubric",
    "",
    "Audit whether the mutated artifact differs from its paired clean control only in ways implied by the declared mutation family and operations.",
    "",
    "- Use only this mutation-auditor directory.",
    "- Do not inspect promotion labels, system predictions, the private map, or another auditor's records.",
    "- Use one stable pseudonymous `auditor_id` for the entire file.",
    "- Mark `isolated` only when no additional scientific or governance defect is introduced.",
    "- Mark `confounded` when any additional defect is introduced and name it in `additional_faults`.",
    "- Provide an artifact-grounded rationale for every task.",
    "",
    "Return one JSON object per line with the required fields in `mutation-audit-tasks.jsonl`.",
    ""
  ].join("\n");
}

function opaqueMutationAuditId(suiteId: string, caseId: string, artifactSha256: string): string {
  return `mutation-audit-${createHash("sha256").update(`${suiteId}\0${caseId}\0${artifactSha256}`).digest("hex").slice(0, 24)}`;
}

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function isIsolationDecision(value: unknown): value is PromotionMutationIsolationDecision {
  return value === "isolated" || value === "confounded";
}

function sha256String(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/iu.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function portableRef(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath).replace(/\\/gu, "/");
  return relative && !relative.startsWith("../") ? relative : "<external-output>";
}
