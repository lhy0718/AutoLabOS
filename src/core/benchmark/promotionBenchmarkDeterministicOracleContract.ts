import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { hashPromotionArtifactTree } from "./promotionArtifactTree.js";
import { promotionVariantDefinitions } from "./promotionBenchmarkVariants.js";
import type {
  LoadedPromotionBenchmarkSuite,
  PromotionBenchmarkCaseManifest,
  PromotionBenchmarkSuiteManifest,
  PromotionBenchmarkValidationIssue
} from "./promotionBenchmark.js";
import type { PromotionMutationOperation } from "./promotionBenchmarkBuilder.js";

export const PROMOTION_DETERMINISTIC_ORACLE_PROTOCOL_REVISION = "1.0";
export const PROMOTION_DETERMINISTIC_ORACLE_EVIDENCE_ROOT = "oracle";
export const PROMOTION_DETERMINISTIC_ORACLE_DEVELOPMENT_SUITE_REF = "oracle/development-suite/suite.json";
export const PROMOTION_DETERMINISTIC_ORACLE_REGISTRY_REF = "oracle/registry-manifest.json";
export const PROMOTION_DETERMINISTIC_ORACLE_GOLD_REF = "oracle/gold-manifest.json";
export const PROMOTION_DETERMINISTIC_ORACLE_SPLIT_REF = "oracle/split-manifest.json";
export const PROMOTION_DETERMINISTIC_ORACLE_REPORT_REF = "oracle/oracle-report.json";

export type PromotionBenchmarkEvaluationRegime =
  | "naturalistic_human_adjudicated"
  | "controlled_deterministic_fault_injection";

export type PromotionBenchmarkClaimCeiling =
  | "registered_fault_families_only"
  | "naturalistic_generalization_supported";

export type PromotionBenchmarkExternalValidationStatus = "not_run" | "passed" | "failed";

export interface PromotionBenchmarkDeterministicOracleProvenance {
  schema_version: "1.0";
  method: "registry_bound_independent_oracle";
  protocol_revision: typeof PROMOTION_DETERMINISTIC_ORACLE_PROTOCOL_REVISION;
  development_suite_ref: typeof PROMOTION_DETERMINISTIC_ORACLE_DEVELOPMENT_SUITE_REF;
  development_suite_snapshot_sha256: string;
  development_suite_tree_sha256: string;
  test_case_set_sha256: string;
  registry_manifest_ref: typeof PROMOTION_DETERMINISTIC_ORACLE_REGISTRY_REF;
  registry_manifest_sha256: string;
  gold_manifest_ref: typeof PROMOTION_DETERMINISTIC_ORACLE_GOLD_REF;
  gold_manifest_sha256: string;
  split_manifest_ref: typeof PROMOTION_DETERMINISTIC_ORACLE_SPLIT_REF;
  split_manifest_sha256: string;
  oracle_report_ref: typeof PROMOTION_DETERMINISTIC_ORACLE_REPORT_REF;
  oracle_report_sha256: string;
  development_case_count: number;
  test_case_count: number;
  development_base_bundle_count: number;
  test_base_bundle_count: number;
  development_mutation_families: string[];
  test_mutation_families: string[];
}

export interface PromotionDeterministicOracleRegistryManifest {
  schema_version: "1.0";
  protocol_revision: typeof PROMOTION_DETERMINISTIC_ORACLE_PROTOCOL_REVISION;
  method: "frozen_registered_fault_definitions";
  variants: Array<{
    mutation_family: string | null;
    operations: PromotionMutationOperation[];
    gold: PromotionBenchmarkCaseManifest["gold"];
  }>;
}

export interface PromotionDeterministicOracleGoldManifest {
  schema_version: "1.0";
  method: "registry_derived_gold";
  cases: Array<{
    case_id: string;
    base_bundle_id: string;
    mutation_family: string | null;
    gold: PromotionBenchmarkCaseManifest["gold"];
  }>;
}

export interface PromotionDeterministicOracleSplitManifest {
  schema_version: "1.0";
  method: "failure_family_and_source_disjoint";
  development_suite_id: string;
  test_suite_id: string;
  development_suite_snapshot_sha256: string;
  test_case_set_sha256: string;
  development_base_bundle_ids: string[];
  test_base_bundle_ids: string[];
  development_source_sha256: string[];
  test_source_sha256: string[];
  development_mutation_families: string[];
  test_mutation_families: string[];
  leakage_detected: false;
}

export interface PromotionDeterministicOracleCaseResult {
  case_id: string;
  split: "development" | "test";
  mutation_family: string | null;
  registry_match: true;
  mutation_manifest_match: true;
  artifact_replay_match: true;
  clean_control_preserved: true;
}

export interface PromotionDeterministicOracleReport {
  schema_version: "1.0";
  method: "independent_artifact_replay";
  protocol_revision: typeof PROMOTION_DETERMINISTIC_ORACLE_PROTOCOL_REVISION;
  passed: true;
  development_case_count: number;
  test_case_count: number;
  verified_case_count: number;
  quarantined_case_count: 0;
  leakage_detected: false;
  cases: PromotionDeterministicOracleCaseResult[];
}

export interface PromotionDeterministicOracleVerificationInput {
  suiteRoot: string;
  manifest: PromotionBenchmarkSuiteManifest;
  cases: PromotionBenchmarkCaseManifest[];
  caseArtifactRoots: Record<string, string>;
  provenance: PromotionBenchmarkDeterministicOracleProvenance;
  loadSuite: (suitePath: string) => Promise<{
    suite?: LoadedPromotionBenchmarkSuite;
    issues: PromotionBenchmarkValidationIssue[];
  }>;
  hashSuiteSnapshot: (suitePath: string) => Promise<string>;
}

export function canonicalPromotionDeterministicOracleRegistry(): PromotionDeterministicOracleRegistryManifest {
  const variants = promotionVariantDefinitions().map((variant) => ({
    mutation_family: variant.mutation_family || null,
    operations: variant.operations,
    gold: canonicalGold(variant.gold)
  }));
  return {
    schema_version: "1.0",
    protocol_revision: PROMOTION_DETERMINISTIC_ORACLE_PROTOCOL_REVISION,
    method: "frozen_registered_fault_definitions",
    variants: variants.sort((left, right) =>
      (left.mutation_family || "").localeCompare(right.mutation_family || ""))
  };
}

export function parsePromotionDeterministicOracleProvenance(
  value: unknown
): PromotionBenchmarkDeterministicOracleProvenance | undefined {
  if (!isRecord(value)
      || value.schema_version !== "1.0"
      || value.method !== "registry_bound_independent_oracle"
      || value.protocol_revision !== PROMOTION_DETERMINISTIC_ORACLE_PROTOCOL_REVISION
      || value.development_suite_ref !== PROMOTION_DETERMINISTIC_ORACLE_DEVELOPMENT_SUITE_REF
      || !sha256(value.development_suite_snapshot_sha256)
      || !sha256(value.development_suite_tree_sha256)
      || !sha256(value.test_case_set_sha256)
      || value.registry_manifest_ref !== PROMOTION_DETERMINISTIC_ORACLE_REGISTRY_REF
      || !sha256(value.registry_manifest_sha256)
      || value.gold_manifest_ref !== PROMOTION_DETERMINISTIC_ORACLE_GOLD_REF
      || !sha256(value.gold_manifest_sha256)
      || value.split_manifest_ref !== PROMOTION_DETERMINISTIC_ORACLE_SPLIT_REF
      || !sha256(value.split_manifest_sha256)
      || value.oracle_report_ref !== PROMOTION_DETERMINISTIC_ORACLE_REPORT_REF
      || !sha256(value.oracle_report_sha256)
      || !positiveInteger(value.development_case_count)
      || !positiveInteger(value.test_case_count)
      || !positiveInteger(value.development_base_bundle_count)
      || !positiveInteger(value.test_base_bundle_count)
      || !portableStringArray(value.development_mutation_families)
      || !portableStringArray(value.test_mutation_families)
      || value.development_mutation_families.length === 0
      || value.test_mutation_families.length === 0
      || !disjoint(value.development_mutation_families, value.test_mutation_families)) {
    return undefined;
  }
  return {
    schema_version: "1.0",
    method: "registry_bound_independent_oracle",
    protocol_revision: PROMOTION_DETERMINISTIC_ORACLE_PROTOCOL_REVISION,
    development_suite_ref: PROMOTION_DETERMINISTIC_ORACLE_DEVELOPMENT_SUITE_REF,
    development_suite_snapshot_sha256: value.development_suite_snapshot_sha256,
    development_suite_tree_sha256: value.development_suite_tree_sha256,
    test_case_set_sha256: value.test_case_set_sha256,
    registry_manifest_ref: PROMOTION_DETERMINISTIC_ORACLE_REGISTRY_REF,
    registry_manifest_sha256: value.registry_manifest_sha256,
    gold_manifest_ref: PROMOTION_DETERMINISTIC_ORACLE_GOLD_REF,
    gold_manifest_sha256: value.gold_manifest_sha256,
    split_manifest_ref: PROMOTION_DETERMINISTIC_ORACLE_SPLIT_REF,
    split_manifest_sha256: value.split_manifest_sha256,
    oracle_report_ref: PROMOTION_DETERMINISTIC_ORACLE_REPORT_REF,
    oracle_report_sha256: value.oracle_report_sha256,
    development_case_count: value.development_case_count,
    test_case_count: value.test_case_count,
    development_base_bundle_count: value.development_base_bundle_count,
    test_base_bundle_count: value.test_base_bundle_count,
    development_mutation_families: [...value.development_mutation_families].sort(),
    test_mutation_families: [...value.test_mutation_families].sort()
  };
}

export async function verifyPromotionDeterministicOracleEvidence(
  input: PromotionDeterministicOracleVerificationInput
): Promise<PromotionBenchmarkValidationIssue[]> {
  const issues: PromotionBenchmarkValidationIssue[] = [];
  const refs = [
    [input.provenance.registry_manifest_ref, input.provenance.registry_manifest_sha256],
    [input.provenance.gold_manifest_ref, input.provenance.gold_manifest_sha256],
    [input.provenance.split_manifest_ref, input.provenance.split_manifest_sha256],
    [input.provenance.oracle_report_ref, input.provenance.oracle_report_sha256]
  ] as const;
  const values = new Map<string, unknown>();
  for (const [ref, expectedHash] of refs) {
    const bytes = await readContainedRegularFile(input.suiteRoot, ref);
    if (!bytes) {
      issues.push({
        code: "deterministic_oracle_evidence_missing_or_unsafe",
        message: "Deterministic oracle evidence must be a regular file inside the suite.",
        ref
      });
      continue;
    }
    if (sha256Bytes(bytes) !== expectedHash) {
      issues.push({
        code: "deterministic_oracle_evidence_hash_mismatch",
        message: "Deterministic oracle evidence hash does not match its provenance binding.",
        ref
      });
      continue;
    }
    try {
      values.set(ref, JSON.parse(bytes.toString("utf8")) as unknown);
    } catch {
      issues.push({
        code: "deterministic_oracle_evidence_invalid_json",
        message: "Deterministic oracle evidence must be valid JSON.",
        ref
      });
    }
  }

  const developmentSuitePath = containedPath(input.suiteRoot, input.provenance.development_suite_ref);
  if (!developmentSuitePath) {
    issues.push({
      code: "deterministic_oracle_development_suite_missing",
      message: "The bound development suite must stay inside the deterministic oracle evidence root.",
      ref: input.provenance.development_suite_ref
    });
    return issues;
  }
  const development = await input.loadSuite(developmentSuitePath);
  if (!development.suite || development.issues.length > 0) {
    issues.push({
      code: "deterministic_oracle_development_suite_invalid",
      message: "The bound development suite must load without validation issues.",
      ref: input.provenance.development_suite_ref
    });
    return issues;
  }
  const developmentRoot = path.dirname(developmentSuitePath);
  if (await input.hashSuiteSnapshot(developmentSuitePath) !== input.provenance.development_suite_snapshot_sha256
      || await hashPromotionArtifactTree(developmentRoot) !== input.provenance.development_suite_tree_sha256) {
    issues.push({
      code: "deterministic_oracle_development_suite_hash_mismatch",
      message: "The development suite no longer matches the bound snapshot and tree hashes.",
      ref: input.provenance.development_suite_ref
    });
  }
  const testCaseSetHash = await hashPromotionDeterministicCaseSet({
    suiteRoot: input.suiteRoot,
    manifest: input.manifest,
    cases: input.cases,
    caseArtifactRoots: input.caseArtifactRoots
  });
  if (testCaseSetHash !== input.provenance.test_case_set_sha256) {
    issues.push({
      code: "deterministic_oracle_test_case_set_hash_mismatch",
      message: "The test case manifests, mutation manifests, or artifacts changed after certification."
    });
  }

  const expectedRegistry = canonicalPromotionDeterministicOracleRegistry();
  if (!deepEqual(values.get(input.provenance.registry_manifest_ref), expectedRegistry)) {
    issues.push({
      code: "deterministic_oracle_registry_mismatch",
      message: "The bound registry does not match the current frozen fault definitions.",
      ref: input.provenance.registry_manifest_ref
    });
  }
  const expectedGold = buildPromotionDeterministicGoldManifest(input.cases);
  if (!deepEqual(values.get(input.provenance.gold_manifest_ref), expectedGold)) {
    issues.push({
      code: "deterministic_oracle_gold_manifest_mismatch",
      message: "The gold manifest must be derived exactly from the frozen registry and current test cases.",
      ref: input.provenance.gold_manifest_ref
    });
  }

  const split = values.get(input.provenance.split_manifest_ref);
  if (!validSplitManifest(split)
      || split.development_suite_id !== development.suite.manifest.suite_id
      || split.test_suite_id !== input.manifest.suite_id
      || split.development_suite_snapshot_sha256 !== input.provenance.development_suite_snapshot_sha256
      || split.test_case_set_sha256 !== input.provenance.test_case_set_sha256
      || !sameStringArray(split.development_mutation_families, input.provenance.development_mutation_families)
      || !sameStringArray(split.test_mutation_families, input.provenance.test_mutation_families)
      || !splitContractMatchesSuites(split, development.suite.cases, input.cases)) {
    issues.push({
      code: "deterministic_oracle_split_manifest_mismatch",
      message: "The split manifest must prove source-, base-, and failure-family-disjoint development and test partitions.",
      ref: input.provenance.split_manifest_ref
    });
  }

  const report = values.get(input.provenance.oracle_report_ref);
  if (!validOracleReport(report)
      || report.development_case_count !== development.suite.cases.length
      || report.test_case_count !== input.cases.length
      || report.verified_case_count !== development.suite.cases.length + input.cases.length
      || report.cases.length !== report.verified_case_count
      || !reportCasesMatchSuites(report.cases, development.suite.cases, input.cases)) {
    issues.push({
      code: "deterministic_oracle_report_mismatch",
      message: "The oracle report must cover every bound development and test case exactly once.",
      ref: input.provenance.oracle_report_ref
    });
  }

  if (development.suite.cases.length !== input.provenance.development_case_count
      || input.cases.length !== input.provenance.test_case_count
      || baseIds(development.suite.cases).length !== input.provenance.development_base_bundle_count
      || baseIds(input.cases).length !== input.provenance.test_base_bundle_count) {
    issues.push({
      code: "deterministic_oracle_count_mismatch",
      message: "Deterministic oracle provenance counts must match both bound suites."
    });
  }
  return issues;
}

export function buildPromotionDeterministicGoldManifest(
  cases: PromotionBenchmarkCaseManifest[]
): PromotionDeterministicOracleGoldManifest {
  const registry = registryByFamily();
  return {
    schema_version: "1.0",
    method: "registry_derived_gold",
    cases: [...cases]
      .sort((left, right) => left.case_id.localeCompare(right.case_id))
      .map((benchmarkCase) => {
        const family = benchmarkCase.mutation_family || null;
        const definition = registry.get(family);
        if (!definition) throw new Error(`Unregistered deterministic fault family: ${family || "clean_control"}.`);
        if (!deepEqual(canonicalGold(benchmarkCase.gold), canonicalGold(definition.gold))) {
          throw new Error(`Case gold does not match the deterministic registry: ${benchmarkCase.case_id}.`);
        }
        return {
          case_id: benchmarkCase.case_id,
          base_bundle_id: benchmarkCase.base_bundle_id,
          mutation_family: family,
          gold: canonicalGold(definition.gold)
        };
      })
  };
}

export function buildPromotionDeterministicSplitManifest(input: {
  development: LoadedPromotionBenchmarkSuite;
  test: LoadedPromotionBenchmarkSuite;
  developmentSuiteSnapshotSha256: string;
  testCaseSetSha256: string;
}): PromotionDeterministicOracleSplitManifest {
  const developmentFamilies = mutationFamilies(input.development.cases);
  const testFamilies = mutationFamilies(input.test.cases);
  const allRegisteredFamilies = registeredFaultFamilies();
  if (!disjoint(developmentFamilies, testFamilies)
      || !sameStringArray([...developmentFamilies, ...testFamilies].sort(), allRegisteredFamilies)
      || !disjoint(baseIds(input.development.cases), baseIds(input.test.cases))
      || !disjoint(sourceHashes(input.development.cases), sourceHashes(input.test.cases))) {
    throw new Error("Development and test suites must be disjoint by failure family, base bundle, and source hash.");
  }
  assertSuiteMatrix(input.development.cases, "development", developmentFamilies);
  assertSuiteMatrix(input.test.cases, "test", testFamilies);
  return {
    schema_version: "1.0",
    method: "failure_family_and_source_disjoint",
    development_suite_id: input.development.manifest.suite_id,
    test_suite_id: input.test.manifest.suite_id,
    development_suite_snapshot_sha256: input.developmentSuiteSnapshotSha256,
    test_case_set_sha256: input.testCaseSetSha256,
    development_base_bundle_ids: baseIds(input.development.cases),
    test_base_bundle_ids: baseIds(input.test.cases),
    development_source_sha256: sourceHashes(input.development.cases),
    test_source_sha256: sourceHashes(input.test.cases),
    development_mutation_families: developmentFamilies,
    test_mutation_families: testFamilies,
    leakage_detected: false
  };
}

export async function hashPromotionDeterministicCaseSet(input: {
  suiteRoot: string;
  manifest: PromotionBenchmarkSuiteManifest;
  cases: PromotionBenchmarkCaseManifest[];
  caseArtifactRoots: Record<string, string>;
}): Promise<string> {
  const caseById = new Map(input.cases.map((benchmarkCase) => [benchmarkCase.case_id, benchmarkCase]));
  const hash = createHash("sha256");
  for (const caseRef of [...input.manifest.cases].sort()) {
    const casePath = containedPath(input.suiteRoot, caseRef);
    if (!casePath) throw new Error(`Case manifest escapes suite root: ${caseRef}.`);
    const bytes = await fs.readFile(casePath);
    const parsed = JSON.parse(bytes.toString("utf8")) as { case_id?: unknown; mutation_manifest?: unknown };
    if (typeof parsed.case_id !== "string" || !caseById.has(parsed.case_id)) {
      throw new Error(`Case manifest is not bound to a loaded deterministic case: ${caseRef}.`);
    }
    hash.update("case_manifest\0" + caseRef.replace(/\\/gu, "/") + "\0");
    hash.update(bytes);
    hash.update("\0");
    if (typeof parsed.mutation_manifest !== "string") {
      throw new Error(`Deterministic case is missing mutation provenance: ${parsed.case_id}.`);
    }
    const mutationPath = containedPath(input.suiteRoot, path.posix.normalize(
      path.posix.join(path.posix.dirname(caseRef.replace(/\\/gu, "/")), parsed.mutation_manifest.replace(/\\/gu, "/"))
    ));
    if (!mutationPath) throw new Error(`Mutation manifest escapes suite root: ${parsed.case_id}.`);
    hash.update("mutation_manifest\0" + parsed.case_id + "\0");
    hash.update(await fs.readFile(mutationPath));
    hash.update("\0");
  }
  for (const benchmarkCase of [...input.cases].sort((left, right) => left.case_id.localeCompare(right.case_id))) {
    const artifactRoot = input.caseArtifactRoots[benchmarkCase.case_id];
    if (!artifactRoot) throw new Error(`Missing artifact root for deterministic case: ${benchmarkCase.case_id}.`);
    hash.update("artifact_tree\0" + benchmarkCase.case_id + "\0");
    hash.update(await hashPromotionArtifactTree(artifactRoot));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function registeredFaultFamilies(): string[] {
  return canonicalPromotionDeterministicOracleRegistry().variants
    .flatMap((variant) => variant.mutation_family ? [variant.mutation_family] : [])
    .sort();
}

function registryByFamily(): Map<string | null, PromotionDeterministicOracleRegistryManifest["variants"][number]> {
  return new Map(canonicalPromotionDeterministicOracleRegistry().variants.map((variant) => [variant.mutation_family, variant]));
}

function validSplitManifest(value: unknown): value is PromotionDeterministicOracleSplitManifest {
  return isRecord(value)
    && value.schema_version === "1.0"
    && value.method === "failure_family_and_source_disjoint"
    && nonEmptyString(value.development_suite_id)
    && nonEmptyString(value.test_suite_id)
    && sha256(value.development_suite_snapshot_sha256)
    && sha256(value.test_case_set_sha256)
    && portableStringArray(value.development_base_bundle_ids)
    && portableStringArray(value.test_base_bundle_ids)
    && sha256Array(value.development_source_sha256)
    && sha256Array(value.test_source_sha256)
    && portableStringArray(value.development_mutation_families)
    && portableStringArray(value.test_mutation_families)
    && value.leakage_detected === false;
}

function validOracleReport(value: unknown): value is PromotionDeterministicOracleReport {
  return isRecord(value)
    && value.schema_version === "1.0"
    && value.method === "independent_artifact_replay"
    && value.protocol_revision === PROMOTION_DETERMINISTIC_ORACLE_PROTOCOL_REVISION
    && value.passed === true
    && positiveInteger(value.development_case_count)
    && positiveInteger(value.test_case_count)
    && positiveInteger(value.verified_case_count)
    && value.quarantined_case_count === 0
    && value.leakage_detected === false
    && Array.isArray(value.cases)
    && value.cases.every(validOracleCaseResult);
}

function validOracleCaseResult(value: unknown): value is PromotionDeterministicOracleCaseResult {
  return isRecord(value)
    && nonEmptyString(value.case_id)
    && (value.split === "development" || value.split === "test")
    && (value.mutation_family === null || portableIdentifier(value.mutation_family))
    && value.registry_match === true
    && value.mutation_manifest_match === true
    && value.artifact_replay_match === true
    && value.clean_control_preserved === true;
}

function splitContractMatchesSuites(
  split: PromotionDeterministicOracleSplitManifest,
  developmentCases: PromotionBenchmarkCaseManifest[],
  testCases: PromotionBenchmarkCaseManifest[]
): boolean {
  const developmentFamilies = mutationFamilies(developmentCases);
  const testFamilies = mutationFamilies(testCases);
  try {
    assertSuiteMatrix(developmentCases, "development", developmentFamilies);
    assertSuiteMatrix(testCases, "test", testFamilies);
  } catch {
    return false;
  }
  return sameStringArray(split.development_base_bundle_ids, baseIds(developmentCases))
    && sameStringArray(split.test_base_bundle_ids, baseIds(testCases))
    && sameStringArray(split.development_source_sha256, sourceHashes(developmentCases))
    && sameStringArray(split.test_source_sha256, sourceHashes(testCases))
    && sameStringArray(split.development_mutation_families, developmentFamilies)
    && sameStringArray(split.test_mutation_families, testFamilies)
    && disjoint(split.development_base_bundle_ids, split.test_base_bundle_ids)
    && disjoint(split.development_source_sha256, split.test_source_sha256)
    && disjoint(developmentFamilies, testFamilies)
    && sameStringArray([...developmentFamilies, ...testFamilies].sort(), registeredFaultFamilies());
}

function reportCasesMatchSuites(
  rows: PromotionDeterministicOracleCaseResult[],
  developmentCases: PromotionBenchmarkCaseManifest[],
  testCases: PromotionBenchmarkCaseManifest[]
): boolean {
  const expected = [...developmentCases.map((benchmarkCase) => ({ benchmarkCase, split: "development" as const })),
    ...testCases.map((benchmarkCase) => ({ benchmarkCase, split: "test" as const }))]
    .sort((left, right) => left.benchmarkCase.case_id.localeCompare(right.benchmarkCase.case_id));
  const sortedRows = [...rows].sort((left, right) => left.case_id.localeCompare(right.case_id));
  return sortedRows.length === expected.length && sortedRows.every((row, index) =>
    row.case_id === expected[index]?.benchmarkCase.case_id
    && row.split === expected[index]?.split
    && row.mutation_family === (expected[index]?.benchmarkCase.mutation_family || null));
}

function assertSuiteMatrix(
  cases: PromotionBenchmarkCaseManifest[],
  expectedSplit: "development" | "test",
  expectedFamilies: string[]
): void {
  if (expectedFamilies.length === 0) throw new Error(`${expectedSplit} suite has no fault families.`);
  const byBase = new Map<string, PromotionBenchmarkCaseManifest[]>();
  for (const benchmarkCase of cases) {
    if (benchmarkCase.split !== expectedSplit) throw new Error(`${expectedSplit} suite contains another split.`);
    byBase.set(benchmarkCase.base_bundle_id, [...(byBase.get(benchmarkCase.base_bundle_id) || []), benchmarkCase]);
  }
  if (byBase.size === 0) throw new Error(`${expectedSplit} suite has no base bundles.`);
  for (const baseCases of byBase.values()) {
    const clean = baseCases.filter((benchmarkCase) => !benchmarkCase.mutation_family);
    const families = baseCases.flatMap((benchmarkCase) => benchmarkCase.mutation_family ? [benchmarkCase.mutation_family] : []).sort();
    if (clean.length !== 1 || !sameStringArray(families, expectedFamilies) || baseCases.length !== expectedFamilies.length + 1) {
      throw new Error(`${expectedSplit} suite must have one clean control and one case per declared family for every base.`);
    }
  }
}

function mutationFamilies(cases: PromotionBenchmarkCaseManifest[]): string[] {
  return [...new Set(cases.flatMap((benchmarkCase) => benchmarkCase.mutation_family ? [benchmarkCase.mutation_family] : []))].sort();
}

function baseIds(cases: PromotionBenchmarkCaseManifest[]): string[] {
  return [...new Set(cases.map((benchmarkCase) => benchmarkCase.base_bundle_id))].sort();
}

function sourceHashes(cases: PromotionBenchmarkCaseManifest[]): string[] {
  const hashes = cases.map((benchmarkCase) => benchmarkCase.source_sha256);
  if (hashes.some((value) => !sha256(value))) throw new Error("Deterministic suites require source hashes for every case.");
  return [...new Set(hashes as string[])].sort();
}

function canonicalGold(gold: PromotionBenchmarkCaseManifest["gold"]): PromotionBenchmarkCaseManifest["gold"] {
  return {
    decision: gold.decision,
    blocking_concerns: [...gold.blocking_concerns].sort(),
    repair_owners: [...gold.repair_owners].sort()
  };
}

async function readContainedRegularFile(root: string, ref: string): Promise<Buffer | null> {
  const candidate = containedPath(root, ref);
  if (!candidate) return null;
  try {
    const stat = await fs.lstat(candidate);
    return stat.isFile() && !stat.isSymbolicLink() ? await fs.readFile(candidate) : null;
  } catch {
    return null;
  }
}

function containedPath(root: string, ref: string): string | null {
  if (!safeRelativeRef(ref)) return null;
  const absoluteRoot = path.resolve(root);
  const candidate = path.resolve(absoluteRoot, ref);
  const relative = path.relative(absoluteRoot, candidate);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? candidate : null;
}

function safeRelativeRef(value: unknown): value is string {
  return nonEmptyString(value)
    && !path.isAbsolute(value)
    && !value.includes("\\")
    && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function portableStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(portableIdentifier)
    && new Set(value).size === value.length
    && sameStringArray(value, [...value].sort());
}

function sha256Array(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(sha256)
    && new Set(value).size === value.length
    && sameStringArray(value, [...value].sort());
}

function portableIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/iu.test(value);
}

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function disjoint(left: string[], right: string[]): boolean {
  const values = new Set(left);
  return right.every((value) => !values.has(value));
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
