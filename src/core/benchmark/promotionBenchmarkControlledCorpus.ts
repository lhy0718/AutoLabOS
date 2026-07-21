import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import {
  buildPromotionBenchmarkSuite,
  type PromotionBenchmarkRecipe,
  type PromotionBenchmarkRecipeCase
} from "./promotionBenchmarkBuilder.js";
import { certifyPromotionDeterministicOracle } from "./promotionBenchmarkDeterministicOracleCertification.js";
import { MINIMUM_PROMOTION_PAPER_ELIGIBLE_CASES } from "./promotionBenchmarkConfirmatoryContract.js";
import { promotionVariantDefinitions, type PromotionVariantDefinition } from "./promotionBenchmarkVariants.js";
import { writeSyntheticPromotionBaseBundle } from "./promotionBenchmarkSyntheticCorpus.js";

export interface GenerateControlledPromotionBenchmarkInput {
  cwd: string;
  outDir: string;
  seed?: string;
  developmentBaseBundleCount?: number;
  testBaseBundleCount?: number;
}

export interface GenerateControlledPromotionBenchmarkResult {
  benchmark_id: string;
  seed_sha256: string;
  evaluation_regime: "controlled_deterministic_fault_injection";
  development_mutation_families: string[];
  test_mutation_families: string[];
  development_base_bundle_count: number;
  test_base_bundle_count: number;
  development_case_count: number;
  test_case_count: number;
  paper_claim_eligible: boolean;
  output_dir: string;
  development_suite_path: string;
  test_suite_path: string;
  certified_suite_path: string;
  oracle_report_path: string;
}

const DEFAULT_SEED = "autolabos-controlled-fault-split-v1";
const DEFAULT_DEVELOPMENT_BASE_COUNT = 24;
const MAXIMUM_BASE_COUNT = 10_000;

export async function generateControlledPromotionBenchmark(
  input: GenerateControlledPromotionBenchmarkInput
): Promise<GenerateControlledPromotionBenchmarkResult> {
  const cwd = path.resolve(input.cwd);
  const outDir = path.resolve(cwd, input.outDir);
  assertStrictlyInside(cwd, outDir, "Controlled benchmark output");
  if (await pathExists(outDir)) {
    throw new Error(`Controlled benchmark output already exists: ${portableRef(cwd, outDir)}.`);
  }
  const seed = nonEmptyString(input.seed) ? input.seed : DEFAULT_SEED;
  const split = splitRegisteredVariants(seed);
  const developmentBaseCount = validateBaseCount(
    input.developmentBaseBundleCount ?? DEFAULT_DEVELOPMENT_BASE_COUNT,
    "developmentBaseBundleCount"
  );
  const minimumTestBaseCount = Math.ceil(
    MINIMUM_PROMOTION_PAPER_ELIGIBLE_CASES / (split.test.length + 1)
  );
  const testBaseCount = validateBaseCount(
    input.testBaseBundleCount ?? minimumTestBaseCount,
    "testBaseBundleCount"
  );
  const benchmarkId = "controlled-promotion-benchmark-" + createHash("sha256")
    .update(seed)
    .digest("hex")
    .slice(0, 12);
  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(path.dirname(outDir), `.${path.basename(outDir)}.tmp-`));
  try {
    const developmentRecipePath = await writePartition({
      root: path.join(stagingRoot, "development-source"),
      suiteId: benchmarkId + "-development",
      split: "development",
      variants: split.development,
      baseCount: developmentBaseCount,
      basePrefix: "development-base"
    });
    const testRecipePath = await writePartition({
      root: path.join(stagingRoot, "test-source"),
      suiteId: benchmarkId + "-test",
      split: "test",
      variants: split.test,
      baseCount: testBaseCount,
      basePrefix: "test-base"
    });
    const developmentSuiteDir = path.join(stagingRoot, "development-suite");
    const testSuiteDir = path.join(stagingRoot, "test-suite");
    await buildPromotionBenchmarkSuite({ cwd, recipePath: developmentRecipePath, outDir: developmentSuiteDir });
    await buildPromotionBenchmarkSuite({ cwd, recipePath: testRecipePath, outDir: testSuiteDir });
    const certifiedDir = path.join(stagingRoot, "certified-test-suite");
    const certification = await certifyPromotionDeterministicOracle({
      cwd,
      developmentSuitePath: path.join(developmentSuiteDir, "suite.json"),
      testSuitePath: path.join(testSuiteDir, "suite.json"),
      outDir: certifiedDir
    });
    const manifest = {
      schema_version: "1.0",
      benchmark_id: benchmarkId,
      evaluation_regime: "controlled_deterministic_fault_injection",
      gold_provenance: "registry_bound_independent_oracle",
      split_method: "failure_family_and_source_disjoint",
      seed_sha256: createHash("sha256").update(seed).digest("hex"),
      development_mutation_families: split.development.map((variant) => variant.mutation_family!),
      test_mutation_families: split.test.map((variant) => variant.mutation_family!),
      development_base_bundle_count: developmentBaseCount,
      test_base_bundle_count: testBaseCount,
      development_case_count: developmentBaseCount * (split.development.length + 1),
      test_case_count: testBaseCount * (split.test.length + 1),
      paper_claim_eligible: certification.paper_claim_eligible,
      claim_ceiling: "registered_fault_families_only",
      external_validation_status: "not_run"
    };
    await writeJsonFile(path.join(stagingRoot, "controlled-benchmark-manifest.json"), manifest);
    await fs.rename(stagingRoot, outDir);
    return {
      benchmark_id: manifest.benchmark_id,
      seed_sha256: manifest.seed_sha256,
      evaluation_regime: "controlled_deterministic_fault_injection",
      development_mutation_families: manifest.development_mutation_families,
      test_mutation_families: manifest.test_mutation_families,
      development_base_bundle_count: manifest.development_base_bundle_count,
      test_base_bundle_count: manifest.test_base_bundle_count,
      development_case_count: manifest.development_case_count,
      test_case_count: manifest.test_case_count,
      paper_claim_eligible: manifest.paper_claim_eligible,
      output_dir: portableRef(cwd, outDir),
      development_suite_path: portableRef(cwd, path.join(outDir, "development-suite", "suite.json")),
      test_suite_path: portableRef(cwd, path.join(outDir, "test-suite", "suite.json")),
      certified_suite_path: portableRef(cwd, path.join(outDir, "certified-test-suite", "suite.json")),
      oracle_report_path: portableRef(cwd, path.join(outDir, "certified-test-suite", "oracle", "oracle-report.json"))
    };
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function splitRegisteredVariants(seed: string): {
  development: PromotionVariantDefinition[];
  test: PromotionVariantDefinition[];
} {
  const variants = promotionVariantDefinitions().filter((variant) => variant.mutation_family);
  if (variants.length < 4) throw new Error("Controlled benchmark requires at least four registered fault families.");
  const ranked = [...variants].sort((left, right) => {
    const leftHash = createHash("sha256").update(seed + "\0" + left.mutation_family).digest("hex");
    const rightHash = createHash("sha256").update(seed + "\0" + right.mutation_family).digest("hex");
    return leftHash.localeCompare(rightHash);
  });
  const developmentCount = Math.floor(ranked.length / 2);
  return {
    development: ranked.slice(0, developmentCount).sort(byFamily),
    test: ranked.slice(developmentCount).sort(byFamily)
  };
}

async function writePartition(input: {
  root: string;
  suiteId: string;
  split: "development" | "test";
  variants: PromotionVariantDefinition[];
  baseCount: number;
  basePrefix: string;
}): Promise<string> {
  const cases: PromotionBenchmarkRecipeCase[] = [];
  const clean = promotionVariantDefinitions().find((variant) => !variant.mutation_family);
  if (!clean) throw new Error("Registered fault definitions require one clean control.");
  for (let baseIndex = 0; baseIndex < input.baseCount; baseIndex += 1) {
    const baseId = `${input.basePrefix}-${baseIndex + 1}`;
    const sourceRoot = path.join(input.root, "base-bundles", baseId);
    const delta = [0.1, 0, -0.05, 0.02][baseIndex % 4]!;
    await writeSyntheticPromotionBaseBundle(sourceRoot, baseId, delta, baseIndex);
    for (const [variantIndex, variant] of [clean, ...input.variants].entries()) {
      cases.push({
        case_id: `${input.split}-case-${baseIndex + 1}-${variantIndex + 1}`,
        base_bundle_id: baseId,
        split: input.split,
        source_root: `base-bundles/${baseId}`,
        ...(variant.mutation_family ? { mutation_family: variant.mutation_family } : {}),
        operations: variant.operations,
        gold: variant.gold
      });
    }
  }
  const recipe: PromotionBenchmarkRecipe = {
    schema_version: "1.0",
    suite_id: input.suiteId,
    evidence_class: "synthetic_development",
    paper_claim_eligible: false,
    adjudication_status: "unreviewed",
    mutation_isolation_status: "unreviewed",
    execution_provenance_status: "unverified",
    cases
  };
  const recipePath = path.join(input.root, "recipe.json");
  await writeJsonFile(recipePath, recipe);
  return recipePath;
}

function validateBaseCount(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > MAXIMUM_BASE_COUNT) {
    throw new Error(`${label} must be an integer from 1 to ${MAXIMUM_BASE_COUNT}.`);
  }
  return value;
}

function byFamily(left: PromotionVariantDefinition, right: PromotionVariantDefinition): number {
  return left.mutation_family!.localeCompare(right.mutation_family!);
}

function assertStrictlyInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside the workspace.`);
  }
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function portableRef(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath).replace(/\\/gu, "/");
  return relative && !relative.startsWith("../") ? relative : "<external-output>";
}
