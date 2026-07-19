import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import {
  hashPromotionArtifactTree,
  loadPromotionBenchmarkSuite,
  type PromotionBenchmarkCaseManifest,
  type PromotionBenchmarkSuiteManifest
} from "./promotionBenchmark.js";
import {
  evaluatePromotionBenchmarkRecovery,
  type PromotionRecoveryManifest,
  type PromotionRecoveryReport
} from "./promotionBenchmarkRecovery.js";
import {
  runPromotionBenchmarkSystems,
  verifyPromotionBenchmarkSystemRun,
  type PromotionBenchmarkSystemName
} from "./promotionBenchmarkSystems.js";
import { promotionVariantDefinitions } from "./promotionBenchmarkVariants.js";

export interface RunPromotionDevelopmentRecoveryInput {
  cwd: string;
  suitePath: string;
  originalPredictionsPath: string;
  originalSystemRunManifestPath: string;
  repairedSuiteId: string;
  repairedTrialId: string;
  outDir: string;
}

export interface PromotionDevelopmentRecoverySummary {
  schema_version: "1.0";
  evidence_class: "synthetic_development";
  paper_claim_eligible: false;
  development_evidence_verified: true;
  source_suite_id: string;
  repaired_suite_id: string;
  system_id: string;
  original_fault_case_count: number;
  covered_fault_case_count: number;
  missing_fault_case_count: 0;
  successful_recovery_rate: number;
  clean_control_regression_rate: number;
  paper_scale_eligibility_issue_codes: string[];
  evidence_boundary: string;
}

export interface RunPromotionDevelopmentRecoveryResult {
  summary: PromotionDevelopmentRecoverySummary;
  recovery: PromotionRecoveryReport;
  output_dir: string;
  repaired_suite_path: string;
  repaired_predictions_path: string;
  repaired_system_run_manifest_path: string;
  recovery_manifest_path: string;
  recovery_report_path: string;
  summary_path: string;
}

const EXPECTED_DEVELOPMENT_ELIGIBILITY_ISSUES = new Set([
  "original_external_real_run_required",
  "original_paper_claim_eligibility_required",
  "original_double_adjudication_required",
  "original_artifact_execution_required",
  "repaired_external_real_run_required",
  "repaired_double_adjudication_required",
  "repaired_artifact_execution_required"
]);

export async function runPromotionDevelopmentRecovery(
  input: RunPromotionDevelopmentRecoveryInput
): Promise<RunPromotionDevelopmentRecoveryResult> {
  const cwd = path.resolve(input.cwd);
  const suitePath = await resolveExistingInside(cwd, input.suitePath, "Development suite");
  const originalPredictionsPath = await resolveExistingInside(
    cwd,
    input.originalPredictionsPath,
    "Original predictions"
  );
  const originalSystemRunManifestPath = await resolveExistingInside(
    cwd,
    input.originalSystemRunManifestPath,
    "Original system run manifest"
  );
  const outDir = path.resolve(cwd, input.outDir);
  assertStrictlyInside(cwd, outDir, "Development recovery output");
  await assertFreshOutput(outDir);
  assertPortableIdentifier(input.repairedSuiteId, "Repaired suite ID");
  assertPortableIdentifier(input.repairedTrialId, "Repaired trial ID");

  const loaded = await loadPromotionBenchmarkSuite(suitePath);
  if (!loaded.suite || loaded.issues.length > 0) {
    throw new Error(
      "Development recovery requires a valid suite: "
      + loaded.issues.map((issue) => issue.code).join(", ")
    );
  }
  if (loaded.suite.manifest.evidence_class !== "synthetic_development"
      || loaded.suite.manifest.paper_claim_eligible !== false
      || loaded.suite.cases.some((benchmarkCase) => benchmarkCase.split !== "development")) {
    throw new Error(
      "Automatic recovery materialization is restricted to non-paper synthetic development suites."
    );
  }
  if (input.repairedSuiteId === loaded.suite.manifest.suite_id) {
    throw new Error("Repaired suite ID must differ from the source suite ID.");
  }

  const originalSystemRun = await verifyPromotionBenchmarkSystemRun({
    cwd,
    manifestPath: originalSystemRunManifestPath,
    suitePath,
    predictionsPath: originalPredictionsPath
  });
  const fullSystems = originalSystemRun.systems.filter((system) => system.protocol === "full_artifact_policy");
  if (fullSystems.length !== 1) {
    throw new Error("Development recovery requires exactly one declared full artifact-policy system.");
  }
  const fullSystem = fullSystems[0]!.system_id;
  const cleanByBase = validateDevelopmentCaseMatrix(loaded.suite.cases);

  await fs.mkdir(outDir, { recursive: true });
  const repairedSuiteRoot = path.join(outDir, "repaired-suite");
  await fs.mkdir(path.join(repairedSuiteRoot, "cases"), { recursive: true });
  const repairedCaseRefs: string[] = [];
  const pairs: PromotionRecoveryManifest["pairs"] = [];

  for (const sourceCase of loaded.suite.cases) {
    const cleanCase = cleanByBase.get(sourceCase.base_bundle_id)!;
    const cleanArtifactRoot = loaded.suite.case_artifact_roots[cleanCase.case_id]!;
    const repairedCaseId = makeRepairedCaseId(sourceCase.case_id);
    const repairedArtifactRoot = path.join(repairedSuiteRoot, "artifacts", repairedCaseId);
    await fs.mkdir(path.dirname(repairedArtifactRoot), { recursive: true });
    await fs.cp(cleanArtifactRoot, repairedArtifactRoot, {
      recursive: true,
      errorOnExist: true,
      force: false
    });
    const repairedArtifactSha256 = await hashPromotionArtifactTree(repairedArtifactRoot);
    if (!sourceCase.source_sha256 || !sourceCase.artifact_sha256) {
      throw new Error("Development recovery cases require source and artifact SHA-256 bindings.");
    }
    if (!sourceCase.mutation_family && repairedArtifactSha256 !== sourceCase.artifact_sha256) {
      throw new Error("Clean-control materialization changed the artifact tree.");
    }
    if (sourceCase.mutation_family && repairedArtifactSha256 === sourceCase.artifact_sha256) {
      throw new Error("Fault repair did not change the source artifact tree.");
    }

    const repairedCase: PromotionBenchmarkCaseManifest = {
      schema_version: "1.0",
      case_id: repairedCaseId,
      base_bundle_id: sourceCase.base_bundle_id,
      split: "development",
      artifact_root: "../artifacts/" + repairedCaseId,
      source_sha256: sourceCase.source_sha256,
      ...(sourceCase.source_family_id_sha256
        ? { source_family_id_sha256: sourceCase.source_family_id_sha256 }
        : {}),
      ...(sourceCase.operator_group_id_sha256
        ? { operator_group_id_sha256: sourceCase.operator_group_id_sha256 }
        : {}),
      artifact_sha256: repairedArtifactSha256,
      gold: { decision: "promote", blocking_concerns: [], repair_owners: [] }
    };
    const caseRef = "cases/" + repairedCaseId + ".json";
    await writeJsonFile(path.join(repairedSuiteRoot, caseRef), repairedCase);
    repairedCaseRefs.push(caseRef);
    pairs.push(sourceCase.mutation_family
      ? {
          pair_kind: "fault_repair",
          source_case_id: sourceCase.case_id,
          source_trial_id: originalSystemRun.trial_id,
          repaired_case_id: repairedCaseId,
          repaired_trial_id: input.repairedTrialId,
          mutation_family: sourceCase.mutation_family,
          declared_repair_owner: sourceCase.gold.repair_owners[0]!
        }
      : {
          pair_kind: "clean_control",
          source_case_id: sourceCase.case_id,
          source_trial_id: originalSystemRun.trial_id,
          repaired_case_id: repairedCaseId,
          repaired_trial_id: input.repairedTrialId
        });
  }

  const sourceManifest = loaded.suite.manifest;
  const repairedSuiteManifest: PromotionBenchmarkSuiteManifest = {
    schema_version: "1.0",
    suite_id: input.repairedSuiteId,
    evidence_class: "synthetic_development",
    paper_claim_eligible: false,
    adjudication_status: sourceManifest.adjudication_status,
    mutation_isolation_status: sourceManifest.mutation_isolation_status,
    execution_provenance_status: sourceManifest.execution_provenance_status,
    ...(sourceManifest.source_diversity_status
      ? { source_diversity_status: sourceManifest.source_diversity_status }
      : {}),
    cases: repairedCaseRefs
  };
  const repairedSuitePath = path.join(repairedSuiteRoot, "suite.json");
  await writeJsonFile(repairedSuitePath, repairedSuiteManifest);
  const repairedLoad = await loadPromotionBenchmarkSuite(repairedSuitePath);
  if (!repairedLoad.suite || repairedLoad.issues.length > 0) {
    throw new Error(
      "Materialized repaired suite is invalid: "
      + repairedLoad.issues.map((issue) => issue.code).join(", ")
    );
  }

  const repairedRun = await runPromotionBenchmarkSystems({
    cwd,
    suitePath: repairedSuitePath,
    outDir: path.join(outDir, "repaired-run"),
    systems: [fullSystem as PromotionBenchmarkSystemName],
    trialId: input.repairedTrialId
  });
  const recoveryManifestPath = path.join(outDir, "recovery-manifest.json");
  const recoveryManifest: PromotionRecoveryManifest = {
    schema_version: "1.0",
    study_id: loaded.suite.manifest.suite_id,
    original_suite_path: relativeRef(outDir, suitePath),
    repaired_suite_path: relativeRef(outDir, repairedSuitePath),
    original_predictions_path: relativeRef(outDir, originalPredictionsPath),
    repaired_predictions_path: relativeRef(outDir, path.resolve(cwd, repairedRun.predictions_path)),
    original_system_run_manifest_path: relativeRef(outDir, originalSystemRunManifestPath),
    repaired_system_run_manifest_path: relativeRef(outDir, path.resolve(cwd, repairedRun.manifest_path)),
    system_id: fullSystem,
    pairs
  };
  await writeJsonFile(recoveryManifestPath, recoveryManifest);
  const evaluated = await evaluatePromotionBenchmarkRecovery({
    cwd,
    manifestPath: recoveryManifestPath,
    outDir: path.join(outDir, "evaluation")
  });
  assertDevelopmentRecovery(evaluated.report);

  const eligibilityIssueCodes = [...new Set(evaluated.report.issues.map((issue) => issue.code))].sort();
  const summary: PromotionDevelopmentRecoverySummary = {
    schema_version: "1.0",
    evidence_class: "synthetic_development",
    paper_claim_eligible: false,
    development_evidence_verified: true,
    source_suite_id: loaded.suite.manifest.suite_id,
    repaired_suite_id: input.repairedSuiteId,
    system_id: fullSystem,
    original_fault_case_count: evaluated.report.original_fault_case_count,
    covered_fault_case_count: evaluated.report.covered_fault_case_count,
    missing_fault_case_count: 0,
    successful_recovery_rate: evaluated.report.successful_recovery_rate!,
    clean_control_regression_rate: evaluated.report.clean_control_regression_rate!,
    paper_scale_eligibility_issue_codes: eligibilityIssueCodes,
    evidence_boundary:
      "This run verifies development-scale repair materialization, rerun coverage, recovery arithmetic, and clean-control regression. "
      + "It uses synthetic development artifacts and is not eligible for paper claims."
  };
  const summaryPath = path.join(outDir, "development-recovery-summary.json");
  await writeJsonFile(summaryPath, summary);
  return {
    summary,
    recovery: evaluated.report,
    output_dir: portableRef(cwd, outDir),
    repaired_suite_path: portableRef(cwd, repairedSuitePath),
    repaired_predictions_path: repairedRun.predictions_path,
    repaired_system_run_manifest_path: repairedRun.manifest_path,
    recovery_manifest_path: portableRef(cwd, recoveryManifestPath),
    recovery_report_path: evaluated.report_path,
    summary_path: portableRef(cwd, summaryPath)
  };
}

function validateDevelopmentCaseMatrix(
  cases: PromotionBenchmarkCaseManifest[]
): Map<string, PromotionBenchmarkCaseManifest> {
  const expectedFamilies = promotionVariantDefinitions()
    .flatMap((variant) => variant.mutation_family ? [variant.mutation_family] : []);
  const byBase = new Map<string, PromotionBenchmarkCaseManifest[]>();
  for (const benchmarkCase of cases) {
    byBase.set(
      benchmarkCase.base_bundle_id,
      [...(byBase.get(benchmarkCase.base_bundle_id) || []), benchmarkCase]
    );
  }
  const cleanByBase = new Map<string, PromotionBenchmarkCaseManifest>();
  for (const [baseId, baseCases] of byBase) {
    const cleanCases = baseCases.filter((benchmarkCase) =>
      !benchmarkCase.mutation_family
      && benchmarkCase.gold.decision === "promote"
      && benchmarkCase.gold.blocking_concerns.length === 0
      && benchmarkCase.gold.repair_owners.length === 0);
    const familyCounts = new Map<string, number>();
    for (const benchmarkCase of baseCases) {
      if (benchmarkCase.mutation_family) {
        familyCounts.set(
          benchmarkCase.mutation_family,
          (familyCounts.get(benchmarkCase.mutation_family) || 0) + 1
        );
        if (benchmarkCase.gold.decision === "promote" || benchmarkCase.gold.repair_owners.length !== 1) {
          throw new Error("Every development fault case requires non-promotable gold and one repair owner.");
        }
      }
    }
    if (cleanCases.length !== 1
        || baseCases.length !== expectedFamilies.length + 1
        || expectedFamilies.some((family) => familyCounts.get(family) !== 1)
        || [...familyCounts.keys()].some((family) => !expectedFamilies.includes(family))) {
      throw new Error("Development recovery requires one clean control and every registered fault family per base: " + baseId);
    }
    cleanByBase.set(baseId, cleanCases[0]!);
  }
  if (cleanByBase.size === 0) throw new Error("Development recovery suite has no base bundles.");
  return cleanByBase;
}

function assertDevelopmentRecovery(report: PromotionRecoveryReport): void {
  const issueCodes = new Set(report.issues.map((issue) => issue.code));
  const unexpected = [...issueCodes].filter((code) => !EXPECTED_DEVELOPMENT_ELIGIBILITY_ISSUES.has(code));
  const missingExpected = [...EXPECTED_DEVELOPMENT_ELIGIBILITY_ISSUES].filter((code) => !issueCodes.has(code));
  if (report.passed
      || unexpected.length > 0
      || missingExpected.length > 0
      || report.missing_fault_families.length > 0
      || report.missing_fault_case_count !== 0
      || report.covered_fault_case_count !== report.original_fault_case_count
      || report.pairs.some((pair) => !pair.valid)
      || report.successful_recovery_rate === null
      || report.clean_control_regression_rate === null) {
    throw new Error(
      "Development recovery validation failed: "
      + [...unexpected, ...missingExpected.map((code) => "missing:" + code)].join(", ")
    );
  }
}

function makeRepairedCaseId(sourceCaseId: string): string {
  assertPortableIdentifier(sourceCaseId, "Source case ID");
  const digest = createHash("sha256").update(sourceCaseId).digest("hex").slice(0, 12);
  return sourceCaseId.slice(0, 100) + "-repaired-" + digest;
}

async function resolveExistingInside(cwd: string, candidate: string, label: string): Promise<string> {
  const absolutePath = path.resolve(cwd, candidate);
  assertStrictlyInside(cwd, absolutePath, label);
  const realPath = await fs.realpath(absolutePath);
  assertStrictlyInside(cwd, realPath, label);
  if (!(await fs.stat(realPath)).isFile()) throw new Error(label + " must be a file.");
  return realPath;
}

function assertStrictlyInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(label + " must be inside the workspace.");
  }
}

async function assertFreshOutput(outDir: string): Promise<void> {
  try {
    await fs.lstat(outDir);
    throw new Error("Development recovery output already exists: " + outDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function assertPortableIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new Error(label + " must be a portable identifier.");
  }
}

function relativeRef(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath).replace(/\\/gu, "/");
  if (!relative || path.isAbsolute(relative)) throw new Error("Recovery artifact reference is invalid.");
  return relative;
}

function portableRef(cwd: string, absolutePath: string): string {
  return path.relative(cwd, absolutePath).replace(/\\/gu, "/");
}
