import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import {
  hashPromotionBenchmarkSuiteSnapshot,
  loadPromotionBenchmarkSuite,
  type LoadedPromotionBenchmarkSuite,
  type PromotionBenchmarkCaseManifest
} from "./promotionBenchmark.js";
import { hashPromotionArtifactTree } from "./promotionArtifactTree.js";
import {
  MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES,
  MINIMUM_PROMOTION_PAPER_ELIGIBLE_CASES
} from "./promotionBenchmarkConfirmatoryContract.js";
import {
  PROMOTION_DETERMINISTIC_ORACLE_DEVELOPMENT_SUITE_REF,
  PROMOTION_DETERMINISTIC_ORACLE_GOLD_REF,
  PROMOTION_DETERMINISTIC_ORACLE_PROTOCOL_REVISION,
  PROMOTION_DETERMINISTIC_ORACLE_REGISTRY_REF,
  PROMOTION_DETERMINISTIC_ORACLE_REPORT_REF,
  PROMOTION_DETERMINISTIC_ORACLE_SPLIT_REF,
  buildPromotionDeterministicGoldManifest,
  buildPromotionDeterministicSplitManifest,
  canonicalPromotionDeterministicOracleRegistry,
  hashPromotionDeterministicCaseSet,
  verifyPromotionDeterministicOracleEvidence,
  type PromotionBenchmarkDeterministicOracleProvenance,
  type PromotionDeterministicOracleCaseResult,
  type PromotionDeterministicOracleReport
} from "./promotionBenchmarkDeterministicOracleContract.js";
import type { PromotionMutationOperation } from "./promotionBenchmarkBuilder.js";

export interface CertifyPromotionDeterministicOracleInput {
  cwd: string;
  developmentSuitePath: string;
  testSuitePath: string;
  outDir: string;
}

export interface CertifyPromotionDeterministicOracleResult {
  suite_id: string;
  evaluation_regime: "controlled_deterministic_fault_injection";
  claim_ceiling: "registered_fault_families_only";
  external_validation_status: "not_run";
  paper_claim_eligible: boolean;
  development_case_count: number;
  test_case_count: number;
  development_base_bundle_count: number;
  test_base_bundle_count: number;
  output_dir: string;
  suite_path: string;
  oracle_report_path: string;
}

interface CertificationFailure {
  code: string;
  message: string;
  case_id?: string;
}

export async function certifyPromotionDeterministicOracle(
  input: CertifyPromotionDeterministicOracleInput
): Promise<CertifyPromotionDeterministicOracleResult> {
  const cwd = path.resolve(input.cwd);
  const developmentSuitePath = await resolveExistingFile(cwd, input.developmentSuitePath, "Development suite");
  const testSuitePath = await resolveExistingFile(cwd, input.testSuitePath, "Test suite");
  const outDir = path.resolve(cwd, input.outDir);
  assertStrictlyInside(cwd, outDir, "Deterministic oracle output");
  if (await pathExists(outDir)) throw new Error(`Deterministic oracle output already exists: ${portableRef(cwd, outDir)}.`);

  const development = await loadRequiredProvisionalSuite(developmentSuitePath, "development");
  const test = await loadRequiredProvisionalSuite(testSuitePath, "test");
  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(path.dirname(outDir), `.${path.basename(outDir)}.tmp-`));
  try {
    const caseResults = [
      ...(await replayAndVerifySuite(development, "development")),
      ...(await replayAndVerifySuite(test, "test"))
    ].sort((left, right) => left.case_id.localeCompare(right.case_id));
    await fs.cp(test.suite_root, stagingRoot, { recursive: true, force: true });
    const oracleRoot = path.join(stagingRoot, "oracle");
    await fs.mkdir(oracleRoot, { recursive: true });
    const copiedDevelopmentRoot = path.join(oracleRoot, "development-suite");
    await fs.cp(development.suite_root, copiedDevelopmentRoot, {
      recursive: true,
      errorOnExist: true,
      force: false
    });

    const stagedSuitePath = path.join(stagingRoot, "suite.json");
    const stagedDevelopmentSuitePath = path.join(stagingRoot, PROMOTION_DETERMINISTIC_ORACLE_DEVELOPMENT_SUITE_REF);
    const stagedTest = await loadRequiredProvisionalSuite(stagedSuitePath, "test");
    const stagedDevelopment = await loadRequiredProvisionalSuite(stagedDevelopmentSuitePath, "development");
    const developmentSuiteSnapshotSha256 = await hashPromotionBenchmarkSuiteSnapshot(stagedDevelopmentSuitePath);
    const developmentSuiteTreeSha256 = await hashPromotionArtifactTree(copiedDevelopmentRoot);
    const testCaseSetSha256 = await hashPromotionDeterministicCaseSet({
      suiteRoot: stagedTest.suite_root,
      manifest: stagedTest.manifest,
      cases: stagedTest.cases,
      caseArtifactRoots: stagedTest.case_artifact_roots
    });
    const registry = canonicalPromotionDeterministicOracleRegistry();
    const gold = buildPromotionDeterministicGoldManifest(stagedTest.cases);
    const split = buildPromotionDeterministicSplitManifest({
      development: stagedDevelopment,
      test: stagedTest,
      developmentSuiteSnapshotSha256,
      testCaseSetSha256
    });
    const oracleReport: PromotionDeterministicOracleReport = {
      schema_version: "1.0",
      method: "independent_artifact_replay",
      protocol_revision: PROMOTION_DETERMINISTIC_ORACLE_PROTOCOL_REVISION,
      passed: true,
      development_case_count: stagedDevelopment.cases.length,
      test_case_count: stagedTest.cases.length,
      verified_case_count: caseResults.length,
      quarantined_case_count: 0,
      leakage_detected: false,
      cases: caseResults
    };
    await writeJsonFile(path.join(stagingRoot, PROMOTION_DETERMINISTIC_ORACLE_REGISTRY_REF), registry);
    await writeJsonFile(path.join(stagingRoot, PROMOTION_DETERMINISTIC_ORACLE_GOLD_REF), gold);
    await writeJsonFile(path.join(stagingRoot, PROMOTION_DETERMINISTIC_ORACLE_SPLIT_REF), split);
    await writeJsonFile(path.join(stagingRoot, PROMOTION_DETERMINISTIC_ORACLE_REPORT_REF), oracleReport);

    const developmentBaseBundleCount = uniqueBaseCount(stagedDevelopment.cases);
    const testBaseBundleCount = uniqueBaseCount(stagedTest.cases);
    const paperClaimEligible = stagedTest.cases.length >= MINIMUM_PROMOTION_PAPER_ELIGIBLE_CASES
      && testBaseBundleCount >= MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES;
    const provenance: PromotionBenchmarkDeterministicOracleProvenance = {
      schema_version: "1.0",
      method: "registry_bound_independent_oracle",
      protocol_revision: PROMOTION_DETERMINISTIC_ORACLE_PROTOCOL_REVISION,
      development_suite_ref: PROMOTION_DETERMINISTIC_ORACLE_DEVELOPMENT_SUITE_REF,
      development_suite_snapshot_sha256: developmentSuiteSnapshotSha256,
      development_suite_tree_sha256: developmentSuiteTreeSha256,
      test_case_set_sha256: testCaseSetSha256,
      registry_manifest_ref: PROMOTION_DETERMINISTIC_ORACLE_REGISTRY_REF,
      registry_manifest_sha256: await sha256File(path.join(stagingRoot, PROMOTION_DETERMINISTIC_ORACLE_REGISTRY_REF)),
      gold_manifest_ref: PROMOTION_DETERMINISTIC_ORACLE_GOLD_REF,
      gold_manifest_sha256: await sha256File(path.join(stagingRoot, PROMOTION_DETERMINISTIC_ORACLE_GOLD_REF)),
      split_manifest_ref: PROMOTION_DETERMINISTIC_ORACLE_SPLIT_REF,
      split_manifest_sha256: await sha256File(path.join(stagingRoot, PROMOTION_DETERMINISTIC_ORACLE_SPLIT_REF)),
      oracle_report_ref: PROMOTION_DETERMINISTIC_ORACLE_REPORT_REF,
      oracle_report_sha256: await sha256File(path.join(stagingRoot, PROMOTION_DETERMINISTIC_ORACLE_REPORT_REF)),
      development_case_count: stagedDevelopment.cases.length,
      test_case_count: stagedTest.cases.length,
      development_base_bundle_count: developmentBaseBundleCount,
      test_base_bundle_count: testBaseBundleCount,
      development_mutation_families: split.development_mutation_families,
      test_mutation_families: split.test_mutation_families
    };
    const rawSuite = JSON.parse(await fs.readFile(stagedSuitePath, "utf8")) as Record<string, unknown>;
    await writeJsonFile(stagedSuitePath, {
      ...rawSuite,
      evidence_class: "deterministic_fault_injection_test",
      evaluation_regime: "controlled_deterministic_fault_injection",
      claim_ceiling: "registered_fault_families_only",
      external_validation_status: "not_run",
      paper_claim_eligible: paperClaimEligible,
      adjudication_status: "unreviewed",
      mutation_isolation_status: "oracle_verified",
      execution_provenance_status: "unverified",
      deterministic_oracle_provenance: provenance
    });

    const verified = await loadPromotionBenchmarkSuite(stagedSuitePath);
    if (!verified.suite || verified.issues.length > 0) {
      throw certificationError("certified_suite_validation_failed", verified.issues.map((issue) => issue.code).join(", "));
    }
    const oracleIssues = await verifyPromotionDeterministicOracleEvidence({
      suiteRoot: verified.suite.suite_root,
      manifest: verified.suite.manifest,
      cases: verified.suite.cases,
      caseArtifactRoots: verified.suite.case_artifact_roots,
      provenance,
      loadSuite: loadPromotionBenchmarkSuite,
      hashSuiteSnapshot: hashPromotionBenchmarkSuiteSnapshot
    });
    if (oracleIssues.length > 0) {
      throw certificationError("certified_oracle_validation_failed", oracleIssues.map((issue) => issue.code).join(", "));
    }
    await fs.rename(stagingRoot, outDir);
    return {
      suite_id: stagedTest.manifest.suite_id,
      evaluation_regime: "controlled_deterministic_fault_injection",
      claim_ceiling: "registered_fault_families_only",
      external_validation_status: "not_run",
      paper_claim_eligible: paperClaimEligible,
      development_case_count: stagedDevelopment.cases.length,
      test_case_count: stagedTest.cases.length,
      development_base_bundle_count: developmentBaseBundleCount,
      test_base_bundle_count: testBaseBundleCount,
      output_dir: portableRef(cwd, outDir),
      suite_path: portableRef(cwd, path.join(outDir, "suite.json")),
      oracle_report_path: portableRef(cwd, path.join(outDir, PROMOTION_DETERMINISTIC_ORACLE_REPORT_REF))
    };
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    const failure = normalizeCertificationFailure(error);
    await fs.mkdir(outDir, { recursive: true });
    await writeJsonFile(path.join(outDir, "oracle-quarantine-report.json"), {
      schema_version: "1.0",
      status: "quarantined",
      paper_claim_eligible: false,
      issues: [failure]
    });
    throw new Error(`Deterministic oracle certification quarantined the input: ${failure.code}: ${failure.message}`);
  }
}

async function replayAndVerifySuite(
  suite: LoadedPromotionBenchmarkSuite,
  split: "development" | "test"
): Promise<PromotionDeterministicOracleCaseResult[]> {
  const registry = new Map(canonicalPromotionDeterministicOracleRegistry().variants
    .map((variant) => [variant.mutation_family, variant] as const));
  const byBase = new Map<string, PromotionBenchmarkCaseManifest[]>();
  for (const benchmarkCase of suite.cases) {
    byBase.set(benchmarkCase.base_bundle_id, [...(byBase.get(benchmarkCase.base_bundle_id) || []), benchmarkCase]);
  }
  const results: PromotionDeterministicOracleCaseResult[] = [];
  for (const [baseId, cases] of byBase) {
    const cleanCases = cases.filter((benchmarkCase) => !benchmarkCase.mutation_family);
    if (cleanCases.length !== 1) throw certificationError("clean_control_cardinality_invalid", baseId);
    const cleanCase = cleanCases[0]!;
    const cleanRoot = suite.case_artifact_roots[cleanCase.case_id]!;
    const cleanHash = await hashPromotionArtifactTree(cleanRoot);
    if (!cleanCase.source_sha256 || cleanHash !== cleanCase.source_sha256 || cleanHash !== cleanCase.artifact_sha256) {
      throw certificationError("clean_control_not_preserved", baseId, cleanCase.case_id);
    }
    for (const benchmarkCase of cases) {
      if (benchmarkCase.split !== split) throw certificationError("suite_split_mismatch", split, benchmarkCase.case_id);
      if (benchmarkCase.source_sha256 !== cleanCase.source_sha256) {
        throw certificationError("base_source_hash_mismatch", baseId, benchmarkCase.case_id);
      }
      const family = benchmarkCase.mutation_family || null;
      const definition = registry.get(family);
      if (!definition || !sameJson(canonicalGold(benchmarkCase.gold), canonicalGold(definition.gold))) {
        throw certificationError("case_registry_mismatch", family || "clean_control", benchmarkCase.case_id);
      }
      const manifestOperations = await readMutationManifestOperations(suite, benchmarkCase);
      if (!sameJson(manifestOperations, definition.operations)) {
        throw certificationError("mutation_manifest_registry_mismatch", family || "clean_control", benchmarkCase.case_id);
      }
      const actualHash = await hashPromotionArtifactTree(suite.case_artifact_roots[benchmarkCase.case_id]!);
      const replayHash = family === null
        ? cleanHash
        : await replayMutationHash(cleanRoot, definition.operations);
      if (actualHash !== benchmarkCase.artifact_sha256 || actualHash !== replayHash) {
        throw certificationError("artifact_replay_mismatch", family || "clean_control", benchmarkCase.case_id);
      }
      results.push({
        case_id: benchmarkCase.case_id,
        split,
        mutation_family: family,
        registry_match: true,
        mutation_manifest_match: true,
        artifact_replay_match: true,
        clean_control_preserved: true
      });
    }
  }
  return results;
}

async function readMutationManifestOperations(
  suite: LoadedPromotionBenchmarkSuite,
  benchmarkCase: PromotionBenchmarkCaseManifest
): Promise<PromotionMutationOperation[]> {
  const caseRef = await findCaseRef(suite, benchmarkCase.case_id);
  const casePath = path.join(suite.suite_root, ...caseRef.split("/"));
  if (!benchmarkCase.mutation_manifest) throw certificationError("mutation_manifest_missing", benchmarkCase.case_id);
  const mutationPath = path.resolve(path.dirname(casePath), benchmarkCase.mutation_manifest);
  assertContained(suite.suite_root, mutationPath, "Mutation manifest");
  const value = JSON.parse(await fs.readFile(mutationPath, "utf8")) as { operations?: unknown };
  if (!Array.isArray(value.operations)) throw certificationError("mutation_manifest_invalid", benchmarkCase.case_id);
  const operations = value.operations.map((record) => {
    if (!isRecord(record) || !isRecord(record.operation)) {
      throw certificationError("mutation_manifest_record_invalid", benchmarkCase.case_id);
    }
    return record.operation as PromotionMutationOperation;
  });
  return operations;
}

async function findCaseRef(suite: LoadedPromotionBenchmarkSuite, caseId: string): Promise<string> {
  for (const caseRef of suite.manifest.cases) {
    const casePath = path.resolve(suite.suite_root, caseRef);
    assertContained(suite.suite_root, casePath, "Case manifest");
    const value = JSON.parse(await fs.readFile(casePath, "utf8")) as { case_id?: unknown };
    if (value.case_id === caseId) return caseRef;
  }
  throw certificationError("case_manifest_ref_missing", caseId, caseId);
}

async function replayMutationHash(sourceRoot: string, operations: PromotionMutationOperation[]): Promise<string> {
  const tempRoot = await fs.mkdtemp(path.join(path.dirname(sourceRoot), ".oracle-replay-"));
  try {
    await fs.cp(sourceRoot, tempRoot, { recursive: true, force: true });
    for (const operation of operations) await applyIndependentMutation(tempRoot, operation);
    return await hashPromotionArtifactTree(tempRoot);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function applyIndependentMutation(root: string, operation: PromotionMutationOperation): Promise<void> {
  const target = path.resolve(root, operation.path);
  assertContained(root, target, "Oracle mutation target");
  if (operation.op === "delete_path") {
    await fs.rm(target, { recursive: true });
    return;
  }
  const value = JSON.parse(await fs.readFile(target, "utf8")) as unknown;
  if (operation.op === "set_json_pointer") setJsonPointer(value, operation.pointer, operation.value);
  else removeJsonPointer(value, operation.pointer);
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function setJsonPointer(root: unknown, pointer: string, value: unknown): void {
  const { parent, key } = resolveJsonPointerParent(root, pointer);
  if (Array.isArray(parent)) {
    parent[parseArrayIndex(key, parent.length)] = value;
    return;
  }
  if (!isRecord(parent)) throw new Error(`Oracle JSON pointer parent is invalid: ${pointer}.`);
  parent[key] = value;
}

function removeJsonPointer(root: unknown, pointer: string): void {
  const { parent, key } = resolveJsonPointerParent(root, pointer);
  if (Array.isArray(parent)) {
    parent.splice(parseArrayIndex(key, parent.length), 1);
    return;
  }
  if (!isRecord(parent) || !Object.prototype.hasOwnProperty.call(parent, key)) {
    throw new Error(`Oracle JSON pointer does not exist: ${pointer}.`);
  }
  delete parent[key];
}

function resolveJsonPointerParent(root: unknown, pointer: string): { parent: any; key: string } {
  const parts = pointer.slice(1).split("/").map((part) => part.replace(/~1/gu, "/").replace(/~0/gu, "~"));
  const key = parts.pop();
  if (!key) throw new Error(`Oracle JSON pointer must select a value: ${pointer}.`);
  let current: any = root;
  for (const part of parts) {
    current = Array.isArray(current) ? current[parseArrayIndex(part, current.length)] : current?.[part];
    if (current === undefined) throw new Error(`Oracle JSON pointer does not exist: ${pointer}.`);
  }
  return { parent: current, key };
}

function parseArrayIndex(value: string, length: number): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) throw new Error(`Invalid oracle array index: ${value}.`);
  const index = Number(value);
  if (index < 0 || index >= length) throw new Error(`Oracle array index is out of bounds: ${value}.`);
  return index;
}

async function loadRequiredProvisionalSuite(
  suitePath: string,
  split: "development" | "test"
): Promise<LoadedPromotionBenchmarkSuite> {
  const loaded = await loadPromotionBenchmarkSuite(suitePath);
  if (!loaded.suite || loaded.issues.length > 0) {
    throw certificationError("provisional_suite_invalid", loaded.issues.map((issue) => issue.code).join(", "));
  }
  if (loaded.suite.manifest.paper_claim_eligible === true
      || loaded.suite.manifest.deterministic_oracle_provenance
      || loaded.suite.cases.some((benchmarkCase) => benchmarkCase.split !== split)) {
    throw certificationError("provisional_suite_contract_invalid", split);
  }
  return loaded.suite;
}

function canonicalGold(gold: PromotionBenchmarkCaseManifest["gold"]): PromotionBenchmarkCaseManifest["gold"] {
  return {
    decision: gold.decision,
    blocking_concerns: [...gold.blocking_concerns].sort(),
    repair_owners: [...gold.repair_owners].sort()
  };
}

function certificationError(code: string, message: string, caseId?: string): Error {
  const error = new Error(message) as Error & { certification_failure?: CertificationFailure };
  error.certification_failure = { code, message, ...(caseId ? { case_id: caseId } : {}) };
  return error;
}

function normalizeCertificationFailure(error: unknown): CertificationFailure {
  if (error instanceof Error) {
    const failure = (error as Error & { certification_failure?: CertificationFailure }).certification_failure;
    if (failure) return failure;
    return { code: "deterministic_oracle_internal_failure", message: error.message };
  }
  return { code: "deterministic_oracle_internal_failure", message: String(error) };
}

function uniqueBaseCount(cases: PromotionBenchmarkCaseManifest[]): number {
  return new Set(cases.map((benchmarkCase) => benchmarkCase.base_bundle_id)).size;
}

async function resolveExistingFile(cwd: string, candidate: string, label: string): Promise<string> {
  const absolutePath = path.resolve(cwd, candidate);
  assertStrictlyInside(cwd, absolutePath, label);
  const realPath = await fs.realpath(absolutePath);
  assertStrictlyInside(cwd, realPath, label);
  if (!(await fs.stat(realPath)).isFile()) throw new Error(`${label} must be a file.`);
  return realPath;
}

function assertContained(root: string, candidate: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside its root.`);
  }
}

function assertStrictlyInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside the workspace.`);
  }
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

function portableRef(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath).replace(/\\/gu, "/");
  return relative && !relative.startsWith("../") ? relative : "<external-output>";
}
