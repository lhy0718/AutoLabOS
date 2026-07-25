import { createHash } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import { isReproducibleSourceEntry } from "../../utils/reproducibleSource.js";
import type {
  PromotionBenchmarkScoreReport,
  PromotionBenchmarkSystemMetrics
} from "./promotionBenchmark.js";
import type { PromotionProviderAggregateManifest } from "./promotionBenchmarkProviderAggregate.js";
import type { PromotionConfirmatoryGateReport } from "./promotionBenchmarkConfirmatoryGate.js";
import { hashPromotionBenchmarkRuntimeSourceTree } from "./promotionBenchmarkSystems.js";

export interface ExportPromotionAuditPackageInput {
  cwd: string;
  gatePath: string;
  paperRoot: string;
  supportRoot: string;
  supportManifestPath: string;
  outDir: string;
}

export interface ExportPromotionAuditPackageResult {
  output_dir: string;
  projection_manifest_path: string;
  support_manifest_path: string;
  result_table_path: string;
  figure_audit_path: string;
  claim_count: number;
  trial_count: number;
}

interface SupportManifest {
  schema_version: "1.0";
  files: SupportBinding[];
}

interface SupportBinding {
  path: string;
  sha256: string;
  bytes: number;
}

interface ClaimRecord {
  claim_id?: unknown;
  claim?: unknown;
  statement?: unknown;
  status?: unknown;
  artifact_refs?: unknown;
  citation_refs?: unknown;
  evidence_ids?: unknown;
  missing_evidence?: unknown;
}

interface ClaimMap {
  schema_version?: unknown;
  claim_ceiling?: unknown;
  claims?: unknown;
}

interface ProjectedResultRow {
  metric: string;
  baseline_system_id: string;
  comparator_system_id: string;
  baseline: number;
  comparator: number;
  delta: number;
  direction: "higher_better" | "lower_better";
  contrast: "comparator_minus_baseline";
  eligible_case_count: number;
  base_bundle_count: number;
  source_trial_count: number;
  provider_receipt_trial_count: number;
  provider_receipts_are_statistical_replicates: false;
}

interface ProjectionSemanticExpectations {
  benchmark_case_count: number;
  base_bundle_count: number;
  system_count: number;
  scored_prediction_count: number;
  provider_trial_count: number;
  recovery_fault_case_count: number | null;
  recovery_covered_fault_case_count: number | null;
  supported_claim_count: number;
  projected_result_row_count: number;
  oracle_development_case_count: number | null;
  oracle_test_case_count: number | null;
}

const PAPER_FILE_MAPPINGS = [
  ["manuscript.tex", "paper/main.tex"],
  ["manuscript.pdf", "paper/main.pdf"],
  ["manuscript.log", "paper/build.log"],
  ["layout-validation.json", "paper/layout_validation.json"],
  ["acl.sty", "paper/acl.sty"],
  ["acl_natbib.bst", "paper/acl_natbib.bst"],
  ["references.bib", "paper/references.bib"],
  ["claim-evidence-map.json", "paper/academic_claim_evidence_map.json"],
  ["model-claim-evidence-review.json", "paper/model_claim_evidence_review.json"],
  ["reference-evidence-status.json", "paper/reference_evidence_status.json"],
  ["submission-status.json", "paper/submission_status.json"],
  ["refgate_claims.tsv", "paper/refgate_claims.tsv"],
  ["refgate.lock.json", "paper/refgate.lock.json"],
  ["refgate-audit.md", "paper/refgate-audit.md"]
] as const;

const OPTIONAL_PAPER_FILE_MAPPINGS = [
  ["final-model-review-receipt.json", "paper/final_model_review_receipt.json"],
  ["final-ci-receipt.json", "paper/final_ci_receipt.json"],
  ["reference-claim-review-import.json", "paper/reference-claim-review-import.json"],
  ["reference-authority-evidence/packet-manifest.json", "paper/reference-authority-evidence/packet-manifest.json"],
  ["reference-authority-evidence/completed-review.json", "paper/reference-authority-evidence/completed-review.json"],
  ["reference-authority-evidence/preflight-report.json", "paper/reference-authority-evidence/preflight-report.json"],
  ["reference-authority-evidence/final-approval.json", "paper/reference-authority-evidence/final-approval.json"]
] as const;

const VERIFICATION_SCRIPT_PATH = "scripts/verify-audit-package-v1.mjs";
const VERIFICATION_SCRIPT_VERSION = "1.8.0";
const REPRODUCIBILITY_GUIDE_PATH = "REPRODUCIBILITY.md";
const SOURCE_SUPPORT_MANIFEST_PACKAGE_PATH = "source-support-manifest.json";
const REFERENCE_REVIEW_PACKAGE_MANIFEST_PATH = "paper/reference-review-handoff/package-manifest.json";
const CANONICAL_GATE_PACKAGE_PATH = "evidence/gate.json";
const CANONICAL_SCORE_PACKAGE_PATH = "evidence/score.json";
const CANONICAL_INTAKE_PATHS = new Set([
  "governance_condition.json",
  "result_table.json",
  "evidence_store.jsonl",
  "run_record.json",
  "run_config.json",
  "experiment_evidence.json",
  "design_contracts.json",
  "checkpoint/state.json",
  "figure_audit/figure_audit_summary.json",
  "review/decision.json",
  "review/paper_critique.json",
  "paper/claim_evidence_table.json",
  "paper/claim_status_table.json",
  "paper/evidence_links.json",
  "paper/evidence_gate_decision.json",
  "paper/paper_readiness.json",
  CANONICAL_GATE_PACKAGE_PATH,
  CANONICAL_SCORE_PACKAGE_PATH,
  REFERENCE_REVIEW_PACKAGE_MANIFEST_PATH,
  ...PAPER_FILE_MAPPINGS.map(([, destination]) => destination),
  ...OPTIONAL_PAPER_FILE_MAPPINGS.map(([, destination]) => destination)
]);

export async function exportPromotionAuditPackage(
  input: ExportPromotionAuditPackageInput
): Promise<ExportPromotionAuditPackageResult> {
  const cwd = path.resolve(input.cwd);
  const supportRoot = await resolveRealDirectory(cwd, input.supportRoot, "Support root");
  const paperRoot = await resolveRealDirectory(cwd, input.paperRoot, "Paper root");
  const gatePath = await resolveRegularFileInside(supportRoot, input.gatePath, cwd, "Confirmatory gate");
  const supportManifestPath = await resolveRegularFileInside(
    supportRoot,
    input.supportManifestPath,
    cwd,
    "Support manifest"
  );
  const outDir = path.resolve(cwd, input.outDir);
  assertStrictlyInside(cwd, outDir, "Audit package output");
  await assertFreshPath(outDir);

  const gate = await readJsonFile<PromotionConfirmatoryGateReport>(gatePath);
  assertEligibleGate(gate);
  const scorePath = await resolveGateArtifact(
    supportRoot,
    gate.artifacts.score_report_ref,
    gate.artifacts.score_report_sha256,
    "Score report"
  );
  const score = await readJsonFile<PromotionBenchmarkScoreReport>(scorePath);
  assertScoreMatchesGate(score, gate);

  const systemRunManifestPath = await resolveRequiredGateArtifact(
    supportRoot,
    gate.artifacts.system_run_manifest_ref,
    gate.artifacts.system_run_manifest_sha256,
    "System run manifest"
  );
  const providerAggregatePath = await resolveRequiredGateArtifact(
    supportRoot,
    gate.artifacts.provider_aggregate_ref,
    gate.artifacts.provider_aggregate_sha256,
    "Provider aggregate"
  );
  const recoveryReportPath = await resolveRequiredGateArtifact(
    supportRoot,
    gate.artifacts.recovery_report_ref,
    gate.artifacts.recovery_report_sha256,
    "Recovery report"
  );
  const systemRunManifest = await readJsonFile<Record<string, unknown>>(systemRunManifestPath);
  const exactNodeVersion = exactNodeVersionFromSystemRun(systemRunManifest);
  const runtimeBinding = recordValue(systemRunManifest.runtime_binding);
  const sourceTreeSha256 = stringValue(runtimeBinding?.source_tree_sha256);
  const packageLockSha256 = stringValue(runtimeBinding?.package_lock_sha256);
  if (sourceTreeSha256 !== await hashPromotionBenchmarkRuntimeSourceTree(cwd)) {
    throw new Error("System run manifest source tree SHA-256 does not match the export source tree.");
  }
  if (packageLockSha256 !== await sha256File(path.join(cwd, "package-lock.json"))) {
    throw new Error("System run manifest package-lock SHA-256 does not match the export lockfile.");
  }
  const providerAggregate = await readJsonFile<PromotionProviderAggregateManifest>(providerAggregatePath);
  const predictionPath = await resolveManifestArtifact(
    supportRoot,
    systemRunManifest,
    gate.artifacts.input_predictions_sha256,
    "Non-provider predictions"
  );
  const scoredPredictionsPath = await resolveGateArtifact(
    supportRoot,
    score.prediction_ref,
    gate.artifacts.scored_predictions_sha256,
    "Scored predictions"
  );
  const suitePath = await resolveGateArtifact(
    supportRoot,
    score.suite_ref,
    gate.artifacts.suite_sha256,
    "Benchmark suite"
  );
  const suiteManifest = await readJsonFile<Record<string, unknown>>(suitePath);
  assertProviderAggregate(providerAggregate, gate);

  const supportManifest = await readJsonFile<SupportManifest>(supportManifestPath);
  const supportFiles = await verifySupportManifest(supportRoot, supportManifest);
  const automaticallyBoundFiles = await bindAdditionalEvidence(supportRoot, [
    gatePath,
    scorePath,
    systemRunManifestPath,
    providerAggregatePath,
    recoveryReportPath,
    predictionPath,
    scoredPredictionsPath,
    suitePath
  ]);
  const transitiveEvidenceFiles = await expandEvidenceClosure(
    supportRoot,
    mergeBindings(
      supportFiles,
      automaticallyBoundFiles
    )
  );
  const evidenceFiles = mergeBindings(
    transitiveEvidenceFiles,
    await bindProjectSnapshot(supportRoot)
  );

  const claimMapPath = path.join(paperRoot, "claim-evidence-map.json");
  const claimMap = await readJsonFile<ClaimMap>(claimMapPath);
  const submissionStatus = await readJsonFile<Record<string, unknown>>(
    path.join(paperRoot, "submission-status.json")
  );
  const remainingGates = submissionRemainingGates(submissionStatus);
  if (stringValue(claimMap.claim_ceiling) !== gate.claim_ceiling) {
    throw new Error("Academic claim map ceiling must exactly match the hash-bound gate claim ceiling.");
  }
  const claims = normalizeSupportedClaims(claimMap);
  assertClaimArtifactsBound(claims, evidenceFiles);
  await validatePaperLayoutReceipt(paperRoot);
  const claimReview = await validateModelClaimEvidenceReview({
    paperRoot,
    evidenceRoot: supportRoot,
    evidenceBindings: evidenceFiles,
    claimMapPath,
    manuscriptPath: path.join(paperRoot, "manuscript.tex"),
    claims,
    claimCeiling: gate.claim_ceiling
  });
  const resultRows = buildResultRows(score, gate);
  const figureAudit = await auditManuscriptTable(
    path.join(paperRoot, "manuscript.tex"),
    score,
    gate
  );
  if (figureAudit.review_block_required) {
    throw new Error(`Manuscript table audit failed: ${figureAudit.issues.join("; ")}`);
  }

  const staging = `${outDir}.staging-${process.pid}-${Date.now()}`;
  await assertFreshPath(staging);
  try {
    await fs.mkdir(staging, { recursive: true });
    for (const binding of evidenceFiles) {
      await copyBoundFile(supportRoot, staging, binding);
    }
    await copyFile(gatePath, path.join(staging, CANONICAL_GATE_PACKAGE_PATH));
    await copyFile(scorePath, path.join(staging, CANONICAL_SCORE_PACKAGE_PATH));
    for (const [sourceName, destination] of PAPER_FILE_MAPPINGS) {
      const sourcePath = await resolveRegularFileInside(paperRoot, sourceName, paperRoot, `Paper file ${sourceName}`);
      await copyFile(sourcePath, path.join(staging, destination));
    }
    for (const [sourceName, destination] of OPTIONAL_PAPER_FILE_MAPPINGS) {
      const sourcePath = path.join(paperRoot, sourceName);
      if (await regularFileExists(sourcePath)) {
        await copyFile(sourcePath, path.join(staging, destination));
      }
    }
    const sourceSupportManifestPackagePath = path.join(staging, SOURCE_SUPPORT_MANIFEST_PACKAGE_PATH);
    await copyFile(supportManifestPath, sourceSupportManifestPackagePath);
    const sourceSupportManifestBinding = await bindFile(staging, sourceSupportManifestPackagePath);
    if (sourceSupportManifestBinding.sha256 !== await sha256File(supportManifestPath)) {
      throw new Error("Source support manifest changed during package projection.");
    }
    await projectReferenceReviewHandoff({ paperRoot, supportRoot, staging });

    const generatedAt = new Date().toISOString();
    const trialEvidence = providerAggregate.source_runs.map((run) => ({
      trial_id: run.trial_id,
      run_id: run.run_id,
      manifest_path: run.manifest_path,
      manifest_sha256: run.manifest_sha256,
      predictions_sha256: run.predictions_sha256,
      execution_receipt_status: providerAggregate.execution_receipt_status
    }));
    await writeJsonFile(path.join(staging, "governance_condition.json"), {
      name: "gated",
      paper_ready: false,
      readiness_state: "paper_scale_candidate",
      allowed_weak_output_states: ["paper_scale_candidate"],
      claim_ceiling: gate.claim_ceiling,
      remaining_gates: remainingGates,
      done_condition: "The package remains a paper-scale candidate until every declared remaining gate is closed by verified evidence."
    });
    await writeJsonFile(path.join(staging, "result_table.json"), resultRows);
    const metricEvidenceRows = resultRows.map((row, index) => ({
      id: `confirmatory-metric-${index + 1}`,
      metric: row.metric,
      metric_evidence_present: true,
      evidence_ref: normalizeRelativePath(path.relative(supportRoot, scorePath)),
      claim_ceiling: gate.claim_ceiling
    }));
    const claimEvidenceRows = claims.map((claim, index) => ({
      id: `claim-evidence-${index + 1}`,
      claim_id: claim.claim_id,
      model_semantic_review_passed: true,
      claim_evidence_valid: false,
      artifact_refs: claim.artifact_refs,
      claim_ceiling: gate.claim_ceiling,
      validation_method: "independent_model_semantic_validation",
      authority_boundary: "model_review_only_not_human_approval_or_empirical_evidence",
      validation_receipt_ref: "paper/model_claim_evidence_review.json",
      validation_receipt_sha256: claimReview.sha256
    }));
    await fs.writeFile(
      path.join(staging, "evidence_store.jsonl"),
      [...metricEvidenceRows, ...claimEvidenceRows].map((row) => JSON.stringify(row)).join("\n") + "\n",
      "utf8"
    );
    const ruleSystemTrialCounts = [
      gate.system_roles.ungated,
      gate.system_roles.checklist,
      gate.system_roles.full,
      ...gate.system_roles.ablations
    ].map((systemId) => findSystem(score, systemId).trial_count);
    if (new Set(ruleSystemTrialCounts).size !== 1) {
      throw new Error("Rule-system trial counts disagree within the projected benchmark decision evidence.");
    }
    const benchmarkDecisionTrialsPerRuleSystem = ruleSystemTrialCounts[0];
    await writeJsonFile(path.join(staging, "run_config.json"), {
      planned_budget: {
        benchmark_decision_trials_per_rule_system: benchmarkDecisionTrialsPerRuleSystem,
        provider_receipt_trials: gate.provider_repetition.trial_count
      },
      executed_budget: {
        benchmark_decision_trials_per_rule_system: benchmarkDecisionTrialsPerRuleSystem,
        provider_receipt_trials: trialEvidence.length
      },
      provider_receipts_are_statistical_replicates: false,
      evaluation_regime: gate.evaluation_regime,
      claim_ceiling: gate.claim_ceiling
    });
    await writeJsonFile(path.join(staging, "run_record.json"), {
      id: gate.suite_id,
      status: "completed",
      executed_budget: {
        trials: trialEvidence.length,
        trials_semantics: "provider_receipts",
        benchmark_decision_trials_per_rule_system: benchmarkDecisionTrialsPerRuleSystem,
        provider_receipt_trials: trialEvidence.length
      },
      case_count: gate.case_count,
      base_bundle_count: gate.base_bundle_count
    });
    await writeJsonFile(path.join(staging, "experiment_evidence.json"), {
      execution_provenance_status: "verified",
      evidence_boundary: providerAggregate.evidence_boundary,
      trials: trialEvidence,
      trial_semantics: "provider_receipts_not_statistical_replicates"
    });
    await writeJsonFile(path.join(staging, "design_contracts.json"), {
      evaluation_regime: gate.evaluation_regime,
      study_design: gate.study_design,
      claim_ceiling: gate.claim_ceiling,
      external_validation_status: gate.external_validation_status,
      comparative_claim_authorized: true,
      comparative_claim_scope: gate.claim_ceiling,
      superiority_claim_authorized: false,
      sota_ranking_claimed: false,
      sota_evidence_present: false
    });
    await writeJsonFile(path.join(staging, "checkpoint", "state.json"), {
      paper_ready: false,
      run_status: "completed",
      readiness_state: "paper_scale_candidate"
    });
    await writeJsonFile(path.join(staging, "figure_audit", "figure_audit_summary.json"), figureAudit);
    await writeJsonFile(path.join(staging, "review", "decision.json"), {
      outcome: "revise",
      manuscript_type: "paper_scale_candidate",
      paper_ready: false,
      claim_class: gate.claim_class,
      blocker_count: remainingGates.length,
      remaining_gates: remainingGates,
      note: "Post-hoc fixed-suite conformance passed; declared submission gates remain separate."
    });
    await writeJsonFile(path.join(staging, "review", "paper_critique.json"), {
      paper_readiness_state: "paper_scale_candidate",
      claim_ceiling_applied: true,
      evidence_gate_passed: false,
      conformance_gate_passed: true,
      model_review_status: "pending",
      remaining_gates: remainingGates
    });
    await writeJsonFile(path.join(staging, "paper", "claim_evidence_table.json"), {
      claims: claims.map((claim) => ({
        claim_id: claim.claim_id,
        statement: claim.statement,
        artifact_refs: claim.artifact_refs,
        citation_refs: claim.citation_refs,
        strength: claim.status
      }))
    });
    await writeJsonFile(path.join(staging, "paper", "claim_status_table.json"), {
      claims: claims.map((claim) => ({
        claim_id: claim.claim_id,
        statement: claim.statement,
        status: claim.status,
        artifact_refs: claim.artifact_refs,
        citation_refs: claim.citation_refs,
        reproduction_trace_present: claim.artifact_refs.length > 0
      }))
    });
    await writeJsonFile(path.join(staging, "paper", "evidence_links.json"), {
      claims: claims.map((claim, index) => ({
        claim_id: claim.claim_id,
        evidence_ids: [`claim-evidence-${index + 1}`],
        citation_paper_ids: claim.citation_refs
      }))
    });
    await writeJsonFile(path.join(staging, "paper", "evidence_gate_decision.json"), {
      outcome: "post_hoc_conformance_only",
      evidence_gate_passed: false,
      conformance_gate_passed: true,
      paper_ready: false,
      readiness_state: "paper_scale_candidate",
      claim_ceiling: gate.claim_ceiling
    });
    await writeJsonFile(path.join(staging, "paper", "paper_readiness.json"), {
      paper_ready: false,
      readiness_state: "paper_scale_candidate",
      claim_ceiling: gate.claim_ceiling,
      conformance_gate_passed: true,
      prospective_evidence_gate_passed: false,
      remaining_gates: remainingGates
    });

    const reservedPathCollision = evidenceFiles.find((binding) =>
      binding.path === VERIFICATION_SCRIPT_PATH
        || binding.path === REPRODUCIBILITY_GUIDE_PATH
        || binding.path === SOURCE_SUPPORT_MANIFEST_PACKAGE_PATH);
    if (reservedPathCollision) {
      throw new Error(`Reserved audit-package path is already bound: ${reservedPathCollision.path}`);
    }
    const verificationScriptPath = path.join(staging, VERIFICATION_SCRIPT_PATH);
    await fs.mkdir(path.dirname(verificationScriptPath), { recursive: true });
    await fs.writeFile(verificationScriptPath, renderVerificationScript(), "utf8");
    await fs.chmod(verificationScriptPath, 0o755);

    const semanticExpectations = buildSemanticExpectations({
      gate,
      score,
      providerAggregate,
      suiteManifest,
      claimCount: claims.length,
      resultRowCount: resultRows.length
    });
    await fs.writeFile(
      path.join(staging, REPRODUCIBILITY_GUIDE_PATH),
      renderReproducibilityGuide(semanticExpectations, exactNodeVersion),
      "utf8"
    );

    const projectionFiles = await collectFileBindings(staging, new Set([
      "projection-manifest.json",
      "projection-support-manifest.json"
    ]));
    const verificationScriptBinding = requiredBinding(projectionFiles, VERIFICATION_SCRIPT_PATH);
    const reproducibilityBinding = requiredBinding(projectionFiles, REPRODUCIBILITY_GUIDE_PATH);
    await writeJsonFile(path.join(staging, "projection-manifest.json"), {
      schema_version: "1.1",
      generated_at: generatedAt,
      source_gate_sha256: await sha256File(gatePath),
      source_support_manifest_path: SOURCE_SUPPORT_MANIFEST_PACKAGE_PATH,
      source_support_manifest_sha256: sourceSupportManifestBinding.sha256,
      paper_ready: false,
      readiness_state: "paper_scale_candidate",
      claim_ceiling: gate.claim_ceiling,
      verification: {
        schema_version: "1.0",
        script_path: VERIFICATION_SCRIPT_PATH,
        script_version: VERIFICATION_SCRIPT_VERSION,
        script_sha256: verificationScriptBinding.sha256,
        reproducibility_guide_path: REPRODUCIBILITY_GUIDE_PATH,
        reproducibility_guide_sha256: reproducibilityBinding.sha256,
        node_runtime: {
          exact_version: exactNodeVersion,
          source: "system_run_manifest.runtime_binding.node_version"
        }
      },
      semantic_expectations: semanticExpectations,
      files: projectionFiles
    });
    const projectionManifestBinding = await bindFile(staging, path.join(staging, "projection-manifest.json"));
    const projectionSupportFiles = [
      ...evidenceFiles,
      sourceSupportManifestBinding,
      projectionManifestBinding,
      reproducibilityBinding,
      verificationScriptBinding
    ].filter((binding) => !CANONICAL_INTAKE_PATHS.has(binding.path));
    await writeJsonFile(path.join(staging, "projection-support-manifest.json"), {
      schema_version: "1.0",
      files: projectionSupportFiles.sort((left, right) => left.path.localeCompare(right.path))
    });
    await fs.rename(staging, outDir);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }

  return {
    output_dir: portableRef(cwd, outDir),
    projection_manifest_path: portableRef(cwd, path.join(outDir, "projection-manifest.json")),
    support_manifest_path: portableRef(cwd, path.join(outDir, "projection-support-manifest.json")),
    result_table_path: portableRef(cwd, path.join(outDir, "result_table.json")),
    figure_audit_path: portableRef(cwd, path.join(outDir, "figure_audit", "figure_audit_summary.json")),
    claim_count: claims.length,
    trial_count: providerAggregate.source_runs.length
  };
}

function buildSemanticExpectations(input: {
  gate: PromotionConfirmatoryGateReport;
  score: PromotionBenchmarkScoreReport;
  providerAggregate: PromotionProviderAggregateManifest;
  suiteManifest: Record<string, unknown>;
  claimCount: number;
  resultRowCount: number;
}): ProjectionSemanticExpectations {
  const oracle = recordValue(input.suiteManifest.deterministic_oracle_provenance);
  const suiteCases = Array.isArray(input.suiteManifest.cases)
    ? input.suiteManifest.cases.length
    : input.gate.case_count;
  const roleCount = new Set([
    input.gate.system_roles.ungated,
    input.gate.system_roles.checklist,
    input.gate.system_roles.manuscript,
    input.gate.system_roles.full,
    ...input.gate.system_roles.ablations
  ]).size;
  return {
    benchmark_case_count: suiteCases,
    base_bundle_count: input.gate.base_bundle_count,
    system_count: roleCount,
    scored_prediction_count: input.score.prediction_count,
    provider_trial_count: input.providerAggregate.source_runs.length,
    recovery_fault_case_count: input.gate.recovery.original_fault_case_count,
    recovery_covered_fault_case_count: input.gate.recovery.covered_fault_case_count,
    supported_claim_count: input.claimCount,
    projected_result_row_count: input.resultRowCount,
    oracle_development_case_count: nonNegativeIntegerValue(oracle?.development_case_count),
    oracle_test_case_count: nonNegativeIntegerValue(oracle?.test_case_count)
  };
}

function renderReproducibilityGuide(
  expectations: ProjectionSemanticExpectations,
  exactNodeVersion: string
): string {
  const rows = [
    ["Benchmark cases", expectations.benchmark_case_count, "Suite case manifest and confirmatory gate"],
    ["Base bundles", expectations.base_bundle_count, "Unique suite case base-bundle bindings"],
    ["System conditions", expectations.system_count, "Confirmatory gate system roles"],
    ["Scored predictions", expectations.scored_prediction_count, "Hash-bound score report"],
    ["Provider trials", expectations.provider_trial_count, "Provider aggregate source runs"],
    ["Recovery fault cases", expectations.recovery_fault_case_count, "Recovery report and gate"],
    ["Covered recovery fault cases", expectations.recovery_covered_fault_case_count, "Recovery report and gate"],
    ["Supported claims", expectations.supported_claim_count, "Projected claim-evidence table"],
    ["Projected result rows", expectations.projected_result_row_count, "Projected result table"],
    ["Oracle development cases", expectations.oracle_development_case_count, "Suite oracle provenance"],
    ["Oracle test cases", expectations.oracle_test_case_count, "Suite oracle provenance"]
  ];
  return [
    "# Reproducibility",
    "",
    "Verification contract: `" + VERIFICATION_SCRIPT_PATH + "` version `"
      + VERIFICATION_SCRIPT_VERSION + "`.",
    "",
    "## Scope",
    "",
    "The package supports byte-level artifact verification, an isolated TypeScript rebuild from hash-bound source, suite and deterministic-oracle integrity checks, fresh execution of the deterministic benchmark systems, deterministic replay of scoring, recovery, provider aggregation, and the conformance gate, plus an isolated rebuild of `paper/main.tex`.",
    "",
    "Provider-chain replay uses preserved run manifests, responses, predictions, and execution receipts. It does not contact a provider or independently establish provider identity.",
    "Fresh deterministic-system execution compares decisions, concerns, repair owners, evidence references, and costs. Wall-clock latency is retained as a diagnostic but excluded from semantic identity because it varies across hosts and runs.",
    "",
    "Artifact verification is not corpus regeneration. When corpus metadata retains only `seed_sha256`, the seed preimage is unavailable and the source corpus cannot be recreated from that digest. The verifier reports this boundary explicitly and checks the frozen suite/oracle artifacts instead.",
    "",
    "## Prerequisites",
    "",
    "- Node.js `" + exactNodeVersion + "` exactly for semantic replay, as bound by the frozen system run manifest. The broader `package.json#engines.node` range describes application compatibility, not byte-identical experiment replay.",
    "- npm with registry or cache access sufficient for `npm ci`.",
    "- The package-local TypeScript compiler installed by `npm ci`.",
    "- `latexmk`, or `pdflatex` plus `bibtex` or `biber` when required by the manuscript.",
    "- An empty writable directory for clean-room extraction; verification uses only package-relative inputs and removes its temporary work directories.",
    "",
    "## Clean-Room Procedure",
    "",
    "Place the package contents in an empty directory, enter that package root, and run:",
    "",
    "```bash",
    "node ./scripts/verify-audit-package-v1.mjs --integrity-only",
    "npm ci",
    "node ./scripts/verify-audit-package-v1.mjs --semantic-only",
    "node ./scripts/verify-audit-package-v1.mjs --pdf-only",
    "```",
    "",
    "The strict package-closure attestation is produced only by `--integrity-only` before installation. After dependencies are present, semantic and PDF verification run separately; `--all` rehashes bound files but explicitly records that post-install package closure was not checked. Semantic verification compiles a fresh runtime under a temporary directory and ignores any pre-existing root `dist/`.",
    "",
    "## Expected Semantic Counts",
    "",
    "All expectations below are generated from package manifests and projected tables; no suite, model, provider, or condition identifier is encoded in the verifier.",
    "",
    "| Semantic object | Expected | Derived from |",
    "| --- | ---: | --- |",
    ...rows.map(([label, value, source]) =>
      "| " + label + " | " + countDisplay(value as number | null) + " | " + source + " |"),
    "",
    "The semantic phase recomputes these counts from the copied artifacts and fails if they diverge from `projection-manifest.json`.",
    "",
    "## Verification Phases",
    "",
    "1. Rehash every regular file listed by `projection-manifest.json` and `projection-support-manifest.json`, including this guide and the versioned verifier.",
    "2. Rehash the package, compile a fresh verification runtime from the bound `src/` tree under a temporary directory, and ignore any root `dist/` content.",
    "3. Verify every declared reference-review source/package mapping, then load the suite with the isolated benchmark module; this validates case trees, snapshot bindings, split isolation, and deterministic-oracle manifests and hashes.",
    "4. Re-run every deterministic benchmark system from the isolated build and compare its semantic predictions with the frozen base predictions, excluding only wall-clock latency.",
    "5. Feed the freshly generated deterministic predictions and run manifest into the conformance-gate CLI together with copied provider run manifests and the recovery manifest. Compare regenerated score, provider aggregate, recovery report, scored prediction semantics, and gate semantics with the frozen artifacts.",
    "6. Copy `paper/` into an isolated temporary directory and rebuild `main.tex`. A valid rebuilt PDF is required; byte identity is not required because TeX toolchains may embed variable metadata.",
    "",
    "A passing run verifies internal package integrity and deterministic replay within the recorded claim ceiling. It does not establish naturalistic generalization, corpus regeneration, external provider identity, independent source sampling, or paper readiness.",
    ""
  ].join("\n");
}

function countDisplay(value: number | null): string {
  return value === null ? "not declared" : String(value);
}

async function projectReferenceReviewHandoff(input: {
  paperRoot: string;
  supportRoot: string;
  staging: string;
}): Promise<void> {
  const sourceStatusPath = path.join(input.paperRoot, "submission-status.json");
  const status = await readJsonFile<Record<string, unknown>>(sourceStatusPath);
  const referenceEvidence = recordValue(status.reference_evidence);
  const modelReview = recordValue(status.model_review);
  if (modelReview) {
    modelReview.claim_evidence_review_package_ref = "paper/model_claim_evidence_review.json";
    modelReview.citation_review_package_ref = "papers/promotion-governance/model-citation-review-receipt.json";
  }
  if (!referenceEvidence) return;

  referenceEvidence.status_artifact_package_ref = "paper/reference_evidence_status.json";
  const handoff = recordValue(referenceEvidence.review_handoff);
  const manifestSourceRef = stringValue(handoff?.manifest);
  if (!handoff || !manifestSourceRef) {
    await writeJsonFile(path.join(input.staging, "paper", "submission_status.json"), status);
    return;
  }

  const normalizedManifestRef = normalizeSupportPath(manifestSourceRef);
  const sourceManifestPath = await resolveRegularFileInside(
    input.supportRoot,
    normalizedManifestRef,
    input.supportRoot,
    "Reference review source manifest"
  );
  const sourceManifest = await readJsonFile<Record<string, unknown>>(sourceManifestPath);
  if (sourceManifest.schema_version !== "1.0") {
    throw new Error("Reference review source manifest must use schema_version 1.0.");
  }
  const manuscriptSourceRef = stringValue(sourceManifest.manuscript_ref);
  if (!manuscriptSourceRef) throw new Error("Reference review source manifest is missing manuscript_ref.");
  const manuscriptSourcePath = await resolveRegularFileInside(
    input.paperRoot,
    manuscriptSourceRef,
    input.paperRoot,
    "Reference review manuscript"
  );
  const manuscriptBinding = await packageProjectionBinding({
    sourceRef: manuscriptSourceRef,
    packageRef: "paper/main.tex",
    sourcePath: manuscriptSourcePath,
    packagePath: path.join(input.staging, "paper", "main.tex")
  });

  const sourceInputDestinations: Record<string, string> = {
    claims: "paper/refgate_claims.tsv",
    status: "paper/reference_evidence_status.json",
    lock: "paper/refgate.lock.json"
  };
  const sourceInputs = [];
  for (const raw of sourceArrayValue(sourceManifest.source_inputs)) {
    const sourceInput = recordValue(raw);
    const role = stringValue(sourceInput?.role);
    const sourceRef = stringValue(sourceInput?.ref);
    const declaredHash = stringValue(sourceInput?.sha256);
    const packageRef = role ? sourceInputDestinations[role] : undefined;
    if (!role || !sourceRef || !packageRef || !declaredHash || !isSha256Digest(declaredHash)) {
      throw new Error("Reference review source input binding is invalid.");
    }
    const sourcePath = await resolveRegularFileInside(
      input.paperRoot,
      sourceRef,
      input.paperRoot,
      `Reference review ${role} input`
    );
    const binding = await packageProjectionBinding({
      sourceRef,
      packageRef,
      sourcePath,
      packagePath: path.join(input.staging, ...packageRef.split("/"))
    });
    if (binding.sha256 !== declaredHash) {
      throw new Error(`Reference review ${role} input does not match its source manifest hash.`);
    }
    sourceInputs.push({ role, ...binding });
  }
  if (sourceInputs.length !== 3 || new Set(sourceInputs.map((binding) => binding.role)).size !== 3) {
    throw new Error("Reference review source manifest must bind claims, status, and lock exactly once.");
  }

  const reviewerFiles = [];
  for (const raw of sourceArrayValue(sourceManifest.files)) {
    const sourceFile = recordValue(raw);
    const relativeRef = stringValue(sourceFile?.path);
    const declaredHash = stringValue(sourceFile?.sha256);
    if (!relativeRef || !declaredHash || !isSha256Digest(declaredHash)) {
      throw new Error("Reference review reviewer-file binding is invalid.");
    }
    const normalizedRelativeRef = normalizeSupportPath(relativeRef);
    const sourcePath = await resolveRegularFileInside(
      path.dirname(sourceManifestPath),
      normalizedRelativeRef,
      path.dirname(sourceManifestPath),
      "Reference review reviewer file"
    );
    const packageRef = normalizeRelativePath(path.posix.join(
      "paper/reference-review-handoff",
      normalizedRelativeRef
    ));
    const packagePath = path.join(input.staging, ...packageRef.split("/"));
    await copyFile(sourcePath, packagePath);
    const binding = await packageProjectionBinding({
      sourceRef: normalizeRelativePath(path.relative(input.supportRoot, sourcePath)),
      packageRef,
      sourcePath,
      packagePath
    });
    if (binding.sha256 !== declaredHash) {
      throw new Error(`Reference review reviewer file does not match its source manifest hash: ${relativeRef}`);
    }
    reviewerFiles.push(binding);
  }

  const sourceManifestPackageRef = "paper/reference-review-handoff/source-manifest.json";
  const sourceManifestPackagePath = path.join(input.staging, ...sourceManifestPackageRef.split("/"));
  await copyFile(sourceManifestPath, sourceManifestPackagePath);
  const sourceManifestBinding = await packageProjectionBinding({
    sourceRef: normalizedManifestRef,
    packageRef: sourceManifestPackageRef,
    sourcePath: sourceManifestPath,
    packagePath: sourceManifestPackagePath
  });
  await writeJsonFile(path.join(input.staging, REFERENCE_REVIEW_PACKAGE_MANIFEST_PATH), {
    schema_version: "1.0",
    handoff_id: stringValue(sourceManifest.handoff_id),
    source_manifest: sourceManifestBinding,
    manuscript: manuscriptBinding,
    source_inputs: sourceInputs,
    reviewer_files: reviewerFiles,
    evidence_boundary: "This package projection maps source review references to package-local files and verifies their byte hashes. It does not contain third-party full texts or confer human review authority."
  });
  handoff.manifest_source_ref = normalizedManifestRef;
  handoff.manifest_package_ref = REFERENCE_REVIEW_PACKAGE_MANIFEST_PATH;
  await writeJsonFile(path.join(input.staging, "paper", "submission_status.json"), status);
}

async function packageProjectionBinding(input: {
  sourceRef: string;
  packageRef: string;
  sourcePath: string;
  packagePath: string;
}): Promise<{ source_ref: string; package_ref: string; sha256: string; bytes: number }> {
  const [sourceBytes, packageBytes] = await Promise.all([
    fs.readFile(input.sourcePath),
    fs.readFile(input.packagePath)
  ]);
  const sourceHash = sha256Bytes(sourceBytes);
  const packageHash = sha256Bytes(packageBytes);
  if (sourceHash !== packageHash || sourceBytes.byteLength !== packageBytes.byteLength) {
    throw new Error(`Reference review package projection changed bytes: ${input.packageRef}`);
  }
  return {
    source_ref: normalizeRelativePath(input.sourceRef),
    package_ref: normalizeRelativePath(input.packageRef),
    sha256: sourceHash,
    bytes: sourceBytes.byteLength
  };
}

function renderVerificationScript(): string {
  return String.raw`#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const SCRIPT_VERSION = "1.8.0";
const SCRIPT_REF = "scripts/verify-audit-package-v1.mjs";
const GUIDE_REF = "REPRODUCIBILITY.md";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODES = new Set(["--all", "--integrity-only", "--semantic-only", "--pdf-only"]);
const RUNTIME_SOURCE_ROOTS = ["src", "package.json", "package-lock.json", "tsconfig.json"];
const TRANSIENT_SOURCE_SUFFIXES = [".orig", ".bak", ".backup", ".rej", ".swp", ".swo"];
const TRANSIENT_SOURCE_FILENAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

const requested = process.argv.slice(2);
if (requested.includes("--help")) {
  process.stdout.write([
    "Usage: node ./scripts/verify-audit-package-v1.mjs [mode] [--report <new-report.json>]",
    "",
    "Modes:",
    "  --integrity-only  Rehash projection and support manifest bindings.",
    "  --semantic-only   Re-run suite/oracle and benchmark semantic checks.",
    "  --pdf-only        Rebuild paper/main.tex in an isolated temporary directory.",
    "  --all             Run every phase (default).",
    "  --report <path>   Retain the JSON report outside the immutable package.",
    "  --version         Print the verification script version."
  ].join("\n") + "\n");
  process.exit(0);
}
if (requested.includes("--version")) {
  process.stdout.write(SCRIPT_VERSION + "\n");
  process.exit(0);
}
const reportIndexes = requested.flatMap((value, index) => value === "--report" ? [index] : []);
if (reportIndexes.length > 1 || (reportIndexes.length === 1 && !requested[reportIndexes[0] + 1])) {
  throw new Error("--report requires one new output path.");
}
const reportOutput = reportIndexes.length === 1 ? requested[reportIndexes[0] + 1] : null;
const operationalArgs = requested.filter((_, index) =>
  !reportIndexes.includes(index) && !reportIndexes.some((reportIndex) => index === reportIndex + 1));
const unknown = operationalArgs.filter((value) => !MODES.has(value));
if (unknown.length > 0 || operationalArgs.filter((value) => MODES.has(value)).length > 1) {
  throw new Error("Select at most one supported verification mode.");
}
const mode = operationalArgs.find((value) => MODES.has(value)) || "--all";

main().catch((error) => {
  process.stderr.write("Audit package verification failed: " + errorMessage(error) + "\n");
  process.exitCode = 1;
});

async function main() {
  const startedAt = new Date().toISOString();
  const manifest = await loadProjectionManifest();
  const report = {
    schema_version: "1.1",
    verification_script_version: SCRIPT_VERSION,
    mode,
    invocation: [SCRIPT_REF, ...requested],
    started_at: startedAt,
    finished_at: null,
    projection_manifest_sha256: await sha256File(path.join(ROOT, "projection-manifest.json")),
    projection_support_manifest_sha256: await sha256File(path.join(ROOT, "projection-support-manifest.json")),
    environment: verificationEnvironment(),
    status: "passed",
    phases: {},
    semantic_counts: null,
    corpus_regeneration: null
  };
  if (mode === "--all" || mode === "--integrity-only") {
    report.phases.integrity = await verifyIntegrity(manifest, {
      enforce_package_closure: mode === "--integrity-only"
    });
  }
  if (mode === "--all" || mode === "--semantic-only") {
    const semantic = await verifySemantics(manifest);
    report.phases.runtime_binding = {
      status: "passed",
      node_version: semantic.node_version,
      source_tree_sha256: semantic.source_tree_sha256,
      package_lock_sha256: semantic.package_lock_sha256
    };
    report.phases.suite_oracle_integrity = { status: "passed" };
    report.phases.deterministic_system_execution = { status: "passed" };
    report.phases.deterministic_scoring = { status: "passed" };
    report.phases.provider_chain = { status: "passed" };
    report.phases.recovery = { status: "passed" };
    report.phases.confirmatory_gate = { status: "passed" };
    report.semantic_counts = semantic.counts;
    report.corpus_regeneration = semantic.corpus_regeneration;
  }
  if (mode === "--all" || mode === "--pdf-only") {
    report.phases.pdf_rebuild = await rebuildPdf();
  }
  report.finished_at = new Date().toISOString();
  const serialized = JSON.stringify(report, null, 2) + "\n";
  if (reportOutput) await retainVerificationReport(reportOutput, serialized);
  process.stdout.write(serialized);
}

async function retainVerificationReport(rawPath, serialized) {
  const outputPath = path.resolve(process.cwd(), rawPath);
  const relative = path.relative(ROOT, outputPath);
  expect(relative.startsWith("..") && !path.isAbsolute(relative),
    "Verification reports must be written outside the immutable package.");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, serialized, { encoding: "utf8", flag: "wx" });
}

async function loadProjectionManifest() {
  const manifest = requireRecord(
    await readJson(path.join(ROOT, "projection-manifest.json")),
    "projection-manifest.json"
  );
  expect(manifest.schema_version === "1.1", "Unsupported projection manifest schema.");
  expect(isSha256(manifest.source_gate_sha256), "Projection manifest source_gate_sha256 is invalid.");
  expect(manifest.source_support_manifest_path === "source-support-manifest.json",
    "Projection manifest source support path is not canonical.");
  expect(isSha256(manifest.source_support_manifest_sha256),
    "Projection manifest source support SHA-256 is invalid.");
  expect(Array.isArray(manifest.files), "Projection manifest files must be an array.");
  const seen = new Set();
  for (const raw of manifest.files) {
    const binding = parseBinding(raw, "projection manifest");
    expect(!seen.has(binding.path), "Duplicate projection manifest path: " + binding.path);
    seen.add(binding.path);
  }
  return manifest;
}

async function verifyIntegrity(manifest, options = { enforce_package_closure: true }) {
  const files = manifest.files.map((value) => parseBinding(value, "projection manifest"));
  for (const binding of files) await verifyBinding(binding);

  const verification = requireRecord(manifest.verification, "projection verification metadata");
  expect(verification.schema_version === "1.0", "Unsupported verification metadata schema.");
  expect(verification.script_path === SCRIPT_REF, "Projection manifest verifier path mismatch.");
  expect(verification.script_version === SCRIPT_VERSION, "Projection manifest verifier version mismatch.");
  expect(verification.reproducibility_guide_path === GUIDE_REF, "Projection manifest guide path mismatch.");
  const scriptBinding = files.find((binding) => binding.path === SCRIPT_REF);
  const guideBinding = files.find((binding) => binding.path === GUIDE_REF);
  expect(Boolean(scriptBinding), "Versioned verification script is absent from the projection manifest.");
  expect(Boolean(guideBinding), "REPRODUCIBILITY.md is absent from the projection manifest.");
  expect(scriptBinding.sha256 === verification.script_sha256, "Verifier metadata hash mismatch.");
  expect(guideBinding.sha256 === verification.reproducibility_guide_sha256, "Guide metadata hash mismatch.");

  const support = requireRecord(
    await readJson(path.join(ROOT, "projection-support-manifest.json")),
    "projection-support-manifest.json"
  );
  expect(support.schema_version === "1.0", "Unsupported projection support manifest schema.");
  const supportBindings = requireArray(support.files, "projection support files")
    .map((value) => parseBinding(value, "projection support manifest"));
  const supportPaths = new Set();
  for (const binding of supportBindings) {
    expect(!supportPaths.has(binding.path), "Duplicate projection support path: " + binding.path);
    supportPaths.add(binding.path);
    await verifyBinding(binding);
  }
  expect(supportPaths.has("projection-manifest.json"), "Support manifest does not bind projection-manifest.json.");
  expect(supportPaths.has(SCRIPT_REF), "Support manifest does not bind the versioned verifier.");
  const sourceSupportPath = requireString(
    manifest.source_support_manifest_path,
    "projection source support manifest path"
  );
  const sourceSupportHash = requireSha256(
    manifest.source_support_manifest_sha256,
    "projection source support manifest SHA-256"
  );
  const sourceSupportBinding = files.find((binding) => binding.path === sourceSupportPath);
  expect(Boolean(sourceSupportBinding), "Projection source support manifest is absent.");
  expect(sourceSupportBinding.sha256 === sourceSupportHash,
    "Projection source support manifest hash disagrees with its file binding.");
  const supportSourceBinding = supportBindings.find((binding) => binding.path === sourceSupportPath);
  expect(Boolean(supportSourceBinding)
    && supportSourceBinding.sha256 === sourceSupportHash
    && supportSourceBinding.bytes === sourceSupportBinding.bytes,
  "Projection support manifest does not bind the declared source support manifest.");
  const sourceSupport = requireRecord(
    await readJson(resolvePortablePath(sourceSupportPath)),
    "source support manifest"
  );
  expect(sourceSupport.schema_version === "1.0" || sourceSupport.schema_version === "1.1",
    "Unsupported source support manifest schema.");
  for (const raw of requireArray(sourceSupport.files, "source support files")) {
    const sourceBinding = parseBinding(raw, "source support manifest");
    const projectedBinding = supportBindings.find((binding) => binding.path === sourceBinding.path);
    expect(Boolean(projectedBinding), "Source support binding is absent from projection support: " + sourceBinding.path);
    expect(projectedBinding.sha256 === sourceBinding.sha256 && projectedBinding.bytes === sourceBinding.bytes,
      "Source and projection support bindings disagree: " + sourceBinding.path);
  }

  const packageClosure = options.enforce_package_closure
    ? await verifyPackageClosure(files, supportBindings)
    : {
      status: "not_checked_post_install",
      reason: "Run --integrity-only before dependency installation for strict package-closure attestation."
    };

  const gatePath = await boundPathByHash(manifest, manifest.source_gate_sha256, "source confirmatory gate");
  const gate = requireRecord(await readJson(gatePath), "confirmatory gate");
  const readiness = requireRecord(
    await readJson(resolvePortablePath("paper/paper_readiness.json")),
    "paper readiness"
  );
  expect(manifest.paper_ready === false && gate.paper_ready === false && readiness.paper_ready === false,
    "Projection, gate, and readiness paper_ready values must all remain false.");
  expect(manifest.readiness_state === gate.readiness
    && manifest.readiness_state === readiness.readiness_state,
  "Projection, gate, and readiness states disagree.");
  expect(manifest.claim_ceiling === gate.claim_ceiling
    && manifest.claim_ceiling === readiness.claim_ceiling,
  "Projection, gate, and readiness claim ceilings disagree.");
  const academicClaimMap = requireRecord(
    await readJson(resolvePortablePath("paper/academic_claim_evidence_map.json")),
    "academic claim evidence map"
  );
  expect(academicClaimMap.claim_ceiling === gate.claim_ceiling,
    "Academic claim map ceiling does not match the hash-bound gate ceiling.");
  await verifyModelClaimEvidenceReview(academicClaimMap);
  const referenceReview = await verifyReferenceReviewProjection();
  return {
    status: "passed",
    projection_file_count: files.length,
    support_file_count: supportBindings.length,
    package_closure: packageClosure,
    reference_review_projection: referenceReview.status
  };
}

async function verifySemantics(manifest) {
  await verifyIntegrity(manifest, { enforce_package_closure: false });
  const nodeVersion = await verifyNodeRuntime(manifest);
  const runtime = await buildVerificationRuntime();
  try {
    return { ...await verifySemanticsWithRuntime(manifest, runtime), node_version: nodeVersion };
  } finally {
    await fs.rm(runtime.root, { recursive: true, force: true });
  }
}

async function verifyPackageClosure(projectionBindings, supportBindings) {
  const expected = new Set([
    ...projectionBindings.map((binding) => binding.path),
    ...supportBindings.map((binding) => binding.path),
    "projection-manifest.json",
    "projection-support-manifest.json"
  ]);
  const actual = [];
  const pending = [ROOT];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(ROOT, absolute).split(path.sep).join("/");
      expect(!entry.isSymbolicLink(), "Package closure contains a symbolic link: " + relative);
      if (entry.isDirectory()) pending.push(absolute);
      else {
        expect(entry.isFile(), "Package closure contains a non-regular entry: " + relative);
        actual.push(relative);
      }
    }
  }
  actual.sort();
  const unexpected = actual.filter((value) => !expected.has(value));
  const missing = [...expected].filter((value) => !actual.includes(value)).sort();
  expect(unexpected.length === 0,
    "Package closure contains unmanifested files: " + unexpected.slice(0, 20).join(", "));
  expect(missing.length === 0,
    "Package closure is missing expected files: " + missing.slice(0, 20).join(", "));
  return {
    status: "passed",
    strict_preinstall_check: true,
    regular_file_count: actual.length,
    unexpected_file_count: 0,
    missing_file_count: 0,
    symbolic_link_count: 0
  };
}

function verificationEnvironment() {
  return {
    node_version: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    npm_version: captureToolVersion("npm", ["--version"]),
    typescript_version: captureToolVersion(
      process.execPath,
      [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "--version"]
    ),
    latexmk_version: captureToolVersion("latexmk", ["-v"]),
    pdflatex_version: captureToolVersion("pdflatex", ["--version"]),
    pdfinfo_version: captureToolVersion("pdfinfo", ["-v"]),
    pdftotext_version: captureToolVersion("pdftotext", ["-v"])
  };
}

function captureToolVersion(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || result.stderr || "").split(/\r?\n/u)[0].trim() || null;
}

async function verifyNodeRuntime(manifest) {
  const verification = requireRecord(manifest.verification, "projection verification metadata");
  const runtime = requireRecord(verification.node_runtime, "projection Node runtime contract");
  const expected = requireString(runtime.exact_version, "projection exact Node version");
  expect(runtime.source === "system_run_manifest.runtime_binding.node_version",
    "Projection Node runtime source is unsupported.");
  expect(/^\d+\.\d+\.\d+$/u.test(expected),
    "Projection must declare one exact Node.js version.");
  expect(process.versions.node === expected,
    "Semantic verification requires Node.js " + expected + " exactly; current runtime is " + process.versions.node + ".");
  return expected;
}

async function verifySemanticsWithRuntime(manifest, runtime) {
  const gatePath = await boundPathByHash(manifest, manifest.source_gate_sha256, "source confirmatory gate");
  const gate = requireRecord(await readJson(gatePath), "confirmatory gate");
  const gateArtifacts = requireRecord(gate.artifacts, "confirmatory gate artifacts");

  const scorePath = await artifactPath(
    gateArtifacts.score_report_ref,
    gateArtifacts.score_report_sha256,
    "score report"
  );
  const score = requireRecord(await readJson(scorePath), "score report");
  const suitePath = await artifactPath(score.suite_ref, gateArtifacts.suite_sha256, "benchmark suite");
  const scoredPredictionsPath = await artifactPath(
    score.prediction_ref,
    gateArtifacts.scored_predictions_sha256,
    "scored predictions"
  );
  const systemRunManifestPath = await artifactPath(
    gateArtifacts.system_run_manifest_ref,
    gateArtifacts.system_run_manifest_sha256,
    "system run manifest"
  );
  const providerAggregatePath = await artifactPath(
    gateArtifacts.provider_aggregate_ref,
    gateArtifacts.provider_aggregate_sha256,
    "provider aggregate"
  );
  const recoveryReportPath = await artifactPath(
    gateArtifacts.recovery_report_ref,
    gateArtifacts.recovery_report_sha256,
    "recovery report"
  );

  const systemRun = requireRecord(await readJson(systemRunManifestPath), "system run manifest");
  const frozenRuntimeBinding = requireRecord(systemRun.runtime_binding, "system run runtime binding");
  expect(frozenRuntimeBinding.node_version === process.version,
    "Frozen system run requires " + String(frozenRuntimeBinding.node_version)
      + "; current runtime is " + process.version + ".");
  const packageSourceTreeSha256 = await hashSystemRuntimeSourceTree(ROOT);
  const packageLockSha256 = await sha256File(path.join(ROOT, "package-lock.json"));
  expect(frozenRuntimeBinding.source_tree_sha256 === packageSourceTreeSha256,
    "Frozen system run source tree SHA-256 does not match the packaged execution source.");
  expect(frozenRuntimeBinding.package_lock_sha256 === packageLockSha256,
    "Frozen system run package-lock SHA-256 does not match the packaged execution lockfile.");
  const systemRunArtifacts = requireRecord(systemRun.artifacts, "system run artifacts");
  const basePredictionsPath = await artifactPath(
    systemRunArtifacts.predictions_path,
    gateArtifacts.input_predictions_sha256,
    "non-provider predictions"
  );
  const providerAggregate = requireRecord(await readJson(providerAggregatePath), "provider aggregate");
  const providerArtifacts = requireRecord(providerAggregate.artifacts, "provider aggregate artifacts");
  await artifactPath(
    providerArtifacts.predictions_path,
    providerArtifacts.predictions_sha256,
    "provider aggregate predictions"
  );
  const recoveryReport = requireRecord(await readJson(recoveryReportPath), "recovery report");
  const recoveryManifestHash = requireSha256(
    recoveryReport.recovery_manifest_sha256,
    "recovery report manifest hash"
  );
  const recoveryManifestPath = await boundPathByHash(
    manifest,
    recoveryManifestHash,
    "recovery manifest required for deterministic replay"
  );
  const recoveryManifest = requireRecord(await readJson(recoveryManifestPath), "recovery manifest");
  const repairExecutionManifestPath = resolveRelativePortablePath(
    recoveryManifestPath,
    requireString(recoveryManifest.repair_execution_manifest_path, "repair execution manifest path")
  );
  const repairExecutionManifest = requireRecord(
    await readJson(repairExecutionManifestPath),
    "repair execution manifest"
  );

  const benchmarkModule = await import(pathToFileURL(runtime.benchmarkModulePath).href);
  expect(
    typeof benchmarkModule.loadPromotionBenchmarkSuite === "function",
    "Built benchmark module does not export loadPromotionBenchmarkSuite."
  );
  const loaded = await benchmarkModule.loadPromotionBenchmarkSuite(suitePath);
  expect(Boolean(loaded.suite), "Benchmark suite did not load.");
  expect(Array.isArray(loaded.issues) && loaded.issues.length === 0,
    "Suite/oracle integrity failed: " + issueCodes(loaded.issues));
  const suite = loaded.suite;
  const suiteManifest = requireRecord(suite.manifest, "loaded suite manifest");
  const cases = requireArray(suite.cases, "loaded suite cases");
  const baseBundleCount = new Set(cases.map((value) =>
    requireString(requireRecord(value, "suite case").base_bundle_id, "case base_bundle_id"))).size;

  const gateRoles = requireRecord(gate.system_roles, "confirmatory gate system roles");
  const roleIds = [
    requireString(gateRoles.ungated, "ungated role"),
    requireString(gateRoles.checklist, "checklist role"),
    requireString(gateRoles.manuscript, "manuscript role"),
    requireString(gateRoles.full, "full role"),
    ...requireArray(gateRoles.ablations, "ablation roles")
      .map((value) => requireString(value, "ablation role"))
  ];
  const uniqueRoleIds = new Set(roleIds);
  expect(uniqueRoleIds.size === roleIds.length, "Confirmatory system roles must be distinct.");

  const systems = requireArray(score.systems, "score systems").map((value) =>
    requireRecord(value, "score system"));
  const scoredSystemIds = new Set(systems.map((value) =>
    requireString(value.system_id, "score system_id")));
  expect(scoredSystemIds.size === uniqueRoleIds.size
    && [...uniqueRoleIds].every((value) => scoredSystemIds.has(value)),
  "Score systems do not exactly match the gate roles.");
  const expectedPredictionCount = systems.reduce((total, system) =>
    total + requireInteger(system.trial_count, "system trial_count") * cases.length, 0);

  const sourceRuns = requireArray(providerAggregate.source_runs, "provider source runs")
    .map((value) => requireRecord(value, "provider source run"));
  const receiptDistinctness = requireRecord(
    providerAggregate.receipt_distinctness,
    "provider receipt-distinctness basis"
  );
  const requiredProviderTrials = requireInteger(
    receiptDistinctness.required_trial_count,
    "required provider trial count"
  );
  expect(receiptDistinctness.statistical_independence_established === false,
    "Provider receipts must not claim statistical independence.");
  expect(receiptDistinctness.statistical_replicates === false,
    "Provider receipt-distinct executions must not be labeled statistical replicates.");
  expect(sourceRuns.length === requiredProviderTrials, "Provider source-run count mismatch.");
  expect(providerAggregate.trial_count === sourceRuns.length, "Provider aggregate trial_count mismatch.");
  expect(providerAggregate.prediction_count === sourceRuns.length * cases.length,
    "Provider aggregate prediction_count mismatch.");
  expect(requireRecord(gate.provider_repetition, "gate provider repetition").trial_count === sourceRuns.length,
    "Gate provider trial count mismatch.");
  for (const run of sourceRuns) {
    await artifactPath(run.manifest_path, run.manifest_sha256, "provider source-run manifest");
  }

  const recoveryPairs = requireArray(recoveryManifest.pairs, "recovery manifest pairs");
  const recoveryReportPairs = requireArray(recoveryReport.pairs, "recovery report pairs");
  expect(recoveryPairs.length === recoveryReportPairs.length, "Recovery manifest/report pair count mismatch.");
  expect(
    recoveryReportPairs.length
      === requireInteger(recoveryReport.fault_repair_pair_count, "fault repair pair count")
        + requireInteger(recoveryReport.clean_control_pair_count, "clean control pair count"),
    "Recovery pair semantic counts are inconsistent."
  );
  const gateRecovery = requireRecord(gate.recovery, "gate recovery");
  expect(gateRecovery.original_fault_case_count === recoveryReport.original_fault_case_count,
    "Gate recovery fault-case count mismatch.");
  expect(gateRecovery.covered_fault_case_count === recoveryReport.covered_fault_case_count,
    "Gate recovery covered count mismatch.");
  expect(gateRecovery.missing_fault_case_count === recoveryReport.missing_fault_case_count,
    "Gate recovery missing count mismatch.");

  expect(gate.case_count === cases.length, "Gate case_count does not match the suite manifest.");
  expect(score.case_count === cases.length, "Score case_count does not match the suite manifest.");
  expect(providerAggregate.case_count === cases.length,
    "Provider aggregate case_count does not match the suite manifest.");
  expect(gate.base_bundle_count === baseBundleCount,
    "Gate base_bundle_count does not match unique suite case manifests.");
  expect(score.prediction_count === expectedPredictionCount,
    "Score prediction_count does not match manifest-derived trial coverage.");

  const claimTable = requireRecord(
    await readJson(resolvePortablePath("paper/claim_evidence_table.json")),
    "claim evidence table"
  );
  const claimStatus = requireRecord(
    await readJson(resolvePortablePath("paper/claim_status_table.json")),
    "claim status table"
  );
  const evidenceLinks = requireRecord(
    await readJson(resolvePortablePath("paper/evidence_links.json")),
    "paper evidence links"
  );
  const claimRows = requireArray(claimTable.claims, "claim evidence rows");
  const statusRows = requireArray(claimStatus.claims, "claim status rows");
  const linkRows = requireArray(evidenceLinks.claims, "claim evidence links");
  const claimCount = claimRows.length;
  expect(statusRows.length === claimCount,
    "Claim evidence/status counts differ.");
  expect(linkRows.length === claimCount,
    "Claim evidence/link counts differ.");
  const claimIds = claimRows.map((row, index) =>
    requireString(requireRecord(row, "claim evidence row " + String(index + 1)).claim_id, "claim ID"));
  expect(new Set(claimIds).size === claimIds.length, "Claim evidence rows contain duplicate claim IDs.");
  const statusIds = statusRows.map((row, index) =>
    requireString(requireRecord(row, "claim status row " + String(index + 1)).claim_id, "claim status ID"));
  const linkIds = linkRows.map((row, index) =>
    requireString(requireRecord(row, "claim link row " + String(index + 1)).claim_id, "claim link ID"));
  expect(new Set(statusIds).size === statusIds.length && new Set(linkIds).size === linkIds.length,
    "Claim status or evidence-link rows contain duplicate claim IDs.");
  expectDeepEqual([...statusIds].sort(), [...claimIds].sort(), "Claim status ID set");
  expectDeepEqual([...linkIds].sort(), [...claimIds].sort(), "Claim evidence-link ID set");
  const claimStrengthById = new Map(claimRows.map((row) => {
    const record = requireRecord(row, "claim evidence row");
    return [requireString(record.claim_id, "claim ID"), requireString(record.strength, "claim strength")];
  }));
  for (const rawStatus of statusRows) {
    const status = requireRecord(rawStatus, "claim status row");
    const claimId = requireString(status.claim_id, "claim status ID");
    expect(status.status === claimStrengthById.get(claimId),
      "Projected claim status does not preserve the source claim strength: " + claimId);
  }

  const resultRows = requireArray(
    await readJson(resolvePortablePath("result_table.json")),
    "projected result table"
  );
  const evidenceRows = (await fs.readFile(resolvePortablePath("evidence_store.jsonl"), "utf8"))
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line, index) => requireRecord(JSON.parse(line), "evidence row " + String(index + 1)));
  expect(evidenceRows.filter((row) => typeof row.metric === "string").length === resultRows.length,
    "Projected result/evidence metric counts differ.");
  expect(evidenceRows.filter((row) => typeof row.claim_id === "string").length === claimCount,
    "Projected claim/evidence counts differ.");
  for (const rawLink of linkRows) {
    const link = requireRecord(rawLink, "claim evidence link");
    const claimId = requireString(link.claim_id, "claim evidence link claim_id");
    const evidenceIds = requireArray(link.evidence_ids, "claim evidence IDs");
    expect(evidenceIds.length > 0, "Every projected claim requires at least one evidence ID.");
    for (const evidenceIdValue of evidenceIds) {
      const evidenceId = requireString(evidenceIdValue, "claim evidence ID");
      const matches = evidenceRows.filter((row) => row.id === evidenceId);
      expect(matches.length === 1, "Claim evidence ID must resolve uniquely: " + evidenceId);
      expect(matches[0].claim_id === claimId
        && matches[0].model_semantic_review_passed === true
        && matches[0].claim_evidence_valid === false,
        "Claim evidence row is invalid or bound to another claim: " + evidenceId);
      expect(matches[0].authority_boundary === "model_review_only_not_human_approval_or_empirical_evidence",
        "Claim evidence row exceeds the model-review authority boundary: " + evidenceId);
      expect(matches[0].validation_method === "independent_model_semantic_validation",
        "Claim evidence row lacks the required semantic validation method: " + evidenceId);
      expect(matches[0].validation_receipt_ref === "paper/model_claim_evidence_review.json",
        "Claim evidence row does not bind the model review receipt: " + evidenceId);
      expect(matches[0].validation_receipt_sha256
        === await sha256File(resolvePortablePath("paper/model_claim_evidence_review.json")),
      "Claim evidence row has a stale model review receipt hash: " + evidenceId);
      expect(requireArray(matches[0].artifact_refs, "claim evidence artifact refs").length > 0,
        "Claim evidence row has no artifact refs: " + evidenceId);
    }
  }
  verifyProjectedResultRows(resultRows, score, gate, sourceRuns.length);

  const oracle = optionalRecord(suiteManifest.deterministic_oracle_provenance);
  if (gate.evaluation_regime === "controlled_deterministic_fault_injection") {
    expect(Boolean(oracle), "Controlled deterministic suite is missing oracle provenance.");
  }
  const oracleDevelopmentCaseCount = oracle
    ? requireInteger(oracle.development_case_count, "oracle development case count")
    : null;
  const oracleTestCaseCount = oracle
    ? requireInteger(oracle.test_case_count, "oracle test case count")
    : null;
  if (oracleTestCaseCount !== null) {
    expect(oracleTestCaseCount === cases.length, "Oracle test case count does not match the loaded suite.");
  }

  const counts = {
    benchmark_case_count: cases.length,
    base_bundle_count: baseBundleCount,
    system_count: systems.length,
    scored_prediction_count: requireInteger(score.prediction_count, "score prediction_count"),
    provider_trial_count: sourceRuns.length,
    recovery_fault_case_count: requireInteger(
      recoveryReport.original_fault_case_count,
      "recovery fault case count"
    ),
    recovery_covered_fault_case_count: requireInteger(
      recoveryReport.covered_fault_case_count,
      "recovery covered fault case count"
    ),
    supported_claim_count: claimCount,
    projected_result_row_count: resultRows.length,
    oracle_development_case_count: oracleDevelopmentCaseCount,
    oracle_test_case_count: oracleTestCaseCount
  };
  verifyExpectedCounts(manifest, counts);

  const corpusRegeneration = await inspectCorpusBoundary(manifest);
  await rerunConfirmatoryChain({
    gate,
    score,
    systemRun,
    providerAggregate,
    recoveryReport,
    recoveryManifest,
    repairExecutionManifest,
    suitePath,
    basePredictionsPath,
    scoredPredictionsPath,
    systemRunManifestPath,
    recoveryManifestPath,
    sourceRuns,
    roleIds,
    gateRoles,
    cliPath: runtime.cliPath
  });
  return {
    counts,
    corpus_regeneration: corpusRegeneration,
    source_tree_sha256: packageSourceTreeSha256,
    package_lock_sha256: packageLockSha256
  };
}

async function verifyModelClaimEvidenceReview(academicClaimMap) {
  const receiptPath = resolvePortablePath("paper/model_claim_evidence_review.json");
  const manuscriptPath = resolvePortablePath("paper/main.tex");
  const claimMapPath = resolvePortablePath("paper/academic_claim_evidence_map.json");
  const receipt = requireRecord(await readJson(receiptPath), "model claim evidence review");
  const policy = requireRecord(receipt.policy, "model claim review policy");
  expect(receipt.schema_version === "1.0"
    && receipt.review_mode === "independent_model_semantic_validation",
  "Unsupported model claim evidence review receipt.");
  expect(receipt.claim_ceiling === academicClaimMap.claim_ceiling,
    "Model claim review ceiling disagrees with the academic claim map.");
  expect(receipt.claim_map_sha256 === await sha256File(claimMapPath)
    && receipt.manuscript_sha256 === await sha256File(manuscriptPath),
  "Model claim review does not bind the packaged claim map and manuscript.");
  expect(policy.creates_empirical_evidence === false
    && policy.may_override_deterministic_gate === false
    && policy.human_authority === false,
  "Model claim review exceeds its allowed authority.");
  const reviewers = requireArray(receipt.reviewers, "model claim reviewers")
    .map((value) => requireRecord(value, "model claim reviewer"));
  expect(reviewers.length >= 2 && reviewers.every(validModelClaimReviewer),
    "Model claim review requires at least two valid isolated reviewers.");
  expect(new Set(reviewers.map((reviewer) => reviewer.reviewer_id)).size === reviewers.length
    && new Set(reviewers.map((reviewer) => reviewer.execution_id)).size === reviewers.length,
  "Model claim reviewers must have distinct reviewer and execution IDs.");
  await Promise.all(reviewers.map(verifyModelClaimReviewerArtifacts));
  const adjudicator = requireRecord(receipt.adjudicator, "model claim adjudicator");
  expect(validModelClaimReviewer(adjudicator) && adjudicator.sees_all_reviewer_outputs === true,
    "Model claim review requires a valid conservative adjudicator.");
  await verifyModelClaimReviewerArtifacts(adjudicator);
  expectDeepEqual(
    requireArray(adjudicator.observed_reviewer_output_sha256s, "meta-reviewer observed output hashes"),
    reviewers.map((reviewer) => reviewer.output_sha256),
    "Meta-reviewer observed reviewer output hashes"
  );

  const claims = requireArray(academicClaimMap.claims, "academic claims")
    .map((value) => requireRecord(value, "academic claim"));
  const reviews = requireArray(receipt.claim_reviews, "model claim reviews")
    .map((value) => requireRecord(value, "model claim review row"));
  const reviewById = new Map(reviews.map((review) => [
    requireString(review.claim_id, "model claim review ID"),
    review
  ]));
  expect(reviews.length === claims.length && reviewById.size === claims.length,
    "Model claim review does not cover the exact claim inventory.");
  for (const claim of claims) {
    const claimId = requireString(claim.claim_id, "academic claim ID");
    const statement = typeof claim.statement === "string" && claim.statement.trim()
      ? claim.statement.trim()
      : requireString(claim.claim, "academic claim statement");
    const status = requireString(claim.status, "academic claim status");
    const artifactRefs = requireArray(claim.artifact_refs, "academic claim artifact refs")
      .map((value) => requireString(value, "academic claim artifact ref"));
    const review = reviewById.get(claimId);
    expect(Boolean(review)
      && review.decision === "supported_within_claim_ceiling"
      && review.status === status
      && review.statement_sha256 === sha256Bytes(Buffer.from(statement, "utf8"))
      && review.artifact_refs_sha256
        === sha256Bytes(Buffer.from(JSON.stringify(artifactRefs), "utf8")),
    "Model claim review is not bound to claim " + claimId + ".");
  }
  return { status: "passed", claim_count: claims.length };
}

function validModelClaimReviewer(value) {
  return typeof value.reviewer_id === "string" && value.reviewer_id.length > 0
    && typeof value.role === "string" && value.role.length > 0
    && typeof value.provider === "string" && value.provider.length > 0
    && typeof value.model === "string" && value.model.length > 0
    && typeof value.execution_id === "string" && value.execution_id.length > 0
    && value.context_isolated === true
    && isSha256(value.input_sha256)
    && isSha256(value.output_sha256)
    && isSha256(value.provider_receipt_sha256)
    && typeof value.input_ref === "string" && value.input_ref.length > 0
    && typeof value.output_ref === "string" && value.output_ref.length > 0
    && typeof value.provider_receipt_ref === "string" && value.provider_receipt_ref.length > 0;
}

async function verifyModelClaimReviewerArtifacts(value) {
  for (const [refField, hashField] of [
    ["input_ref", "input_sha256"],
    ["output_ref", "output_sha256"],
    ["provider_receipt_ref", "provider_receipt_sha256"]
  ]) {
    const ref = requireString(value[refField], "model review artifact reference");
    const artifactPath = resolvePortablePath(ref);
    expect(await sha256File(artifactPath) === value[hashField],
      "Model review artifact hash mismatch: " + ref);
  }
}

async function verifyPaperLayoutReceipt(sourcePaper) {
  const receipt = requireRecord(
    await readJson(path.join(sourcePaper, "layout_validation.json")),
    "paper layout validation"
  );
  const visual = requireRecord(receipt.visual_findings, "paper layout visual findings");
  const artifacts = requireRecord(receipt.artifacts, "paper layout artifact hashes");
  const pageCount = requireInteger(receipt.page_count, "paper page count");
  const inspectedPages = requireArray(receipt.visual_pages_inspected, "visually inspected pages");
  expect(receipt.schema_version === "1.0" && receipt.status === "passed" && pageCount > 0,
    "Paper layout validation did not pass.");
  expectDeepEqual(
    inspectedPages,
    Array.from({ length: pageCount }, (_, index) => index + 1),
    "Paper layout inspected-page inventory"
  );
  expect(receipt.undefined_citations === false
    && receipt.undefined_references === false
    && receipt.overfull_boxes === false,
  "Paper layout validation reports unresolved TeX diagnostics.");
  expect(visual.clipping === false
    && visual.overlap === false
    && visual.table_overflow === false
    && visual.unreadable_content === false,
  "Paper layout validation reports a visual defect.");
  const bindings = [
    ["manuscript_tex_sha256", "main.tex"],
    ["manuscript_pdf_sha256", "main.pdf"],
    ["manuscript_log_sha256", "build.log"],
    ["acl_sty_sha256", "acl.sty"],
    ["acl_natbib_bst_sha256", "acl_natbib.bst"],
    ["references_bib_sha256", "references.bib"]
  ];
  for (const [field, fileName] of bindings) {
    expect(artifacts[field] === await sha256File(path.join(sourcePaper, fileName)),
      "Paper layout validation is stale for " + fileName + ".");
  }
  return { page_count: pageCount };
}

async function rerunConfirmatoryChain(input) {
  const workRoot = await fs.mkdtemp(path.join(ROOT, ".audit-verification-v1-"));
  try {
    const systemOut = path.join(workRoot, "systems");
    const systemArgs = [
      input.cliPath,
      "governance-benchmark",
      "run-promotion",
      "--suite", packageRef(input.suitePath),
      "--trial", requireString(input.systemRun.trial_id, "system run trial_id"),
      "--out-dir", packageRef(systemOut)
    ];
    for (const rawSystem of requireArray(input.systemRun.systems, "system run systems")) {
      const system = requireRecord(rawSystem, "system run system");
      systemArgs.push("--system", requireString(system.system_id, "system run system_id"));
    }
    runCommand(process.execPath, systemArgs, ROOT, "deterministic system execution");
    const rerunSystemManifestPath = path.join(systemOut, "system-run-manifest.json");
    const rerunBasePredictionsPath = path.join(systemOut, "predictions.jsonl");
    const rerunSystemManifest = requireRecord(
      await readJson(rerunSystemManifestPath),
      "rerun system manifest"
    );
    expectDeepEqual(
      normalizeSystemRun(rerunSystemManifest),
      normalizeSystemRun(input.systemRun),
      "Deterministic system run manifest"
    );
    expectDeepEqual(
      normalizePredictions(await readJsonLines(rerunBasePredictionsPath)),
      normalizePredictions(await readJsonLines(input.basePredictionsPath)),
      "Deterministic system predictions"
    );

    const frozenRepairedSuitePath = resolveRelativePortablePath(
      input.recoveryManifestPath,
      requireString(input.recoveryManifest.repaired_suite_path, "frozen repaired suite path")
    );
    const frozenRepairedSuite = requireRecord(
      await readJson(frozenRepairedSuitePath),
      "frozen repaired suite"
    );
    const repairedTrialIds = new Set(
      requireArray(input.recoveryManifest.pairs, "frozen recovery pairs")
        .map((value) => requireString(
          requireRecord(value, "frozen recovery pair").repaired_trial_id,
          "repaired trial id"
        ))
    );
    expect(repairedTrialIds.size === 1, "Frozen recovery pairs must use one repaired trial id.");
    const recoveryOut = path.join(workRoot, "recovery");
    runCommand(
      process.execPath,
      [
        input.cliPath,
        "governance-benchmark",
        "run-promotion-controlled-recovery",
        "--suite", packageRef(input.suitePath),
        "--predictions", packageRef(rerunBasePredictionsPath),
        "--system-run-manifest", packageRef(rerunSystemManifestPath),
        "--repaired-suite-id", requireString(frozenRepairedSuite.suite_id, "repaired suite id"),
        "--repaired-trial-id", [...repairedTrialIds][0],
        "--out-dir", packageRef(recoveryOut)
      ],
      ROOT,
      "controlled recovery execution"
    );
    const rerunRecoveryManifestPath = path.join(recoveryOut, "recovery-manifest.json");
    const rerunRecoveryManifest = requireRecord(
      await readJson(rerunRecoveryManifestPath),
      "rerun recovery manifest"
    );
    const rerunRepairExecutionManifest = requireRecord(
      await readJson(path.join(recoveryOut, "repair-execution-manifest.json")),
      "rerun repair execution manifest"
    );
    expectDeepEqual(
      normalizeRecoveryManifest(rerunRecoveryManifest),
      normalizeRecoveryManifest(input.recoveryManifest),
      "Recovery pairing manifest"
    );
    expectDeepEqual(
      normalizeRepairExecution(rerunRepairExecutionManifest),
      normalizeRepairExecution(input.repairExecutionManifest),
      "Node-owned repair execution"
    );

    const gateOut = path.join(workRoot, "gate");
    const args = [
      input.cliPath,
      "governance-benchmark",
      "gate-promotion-confirmatory",
      "--suite", packageRef(input.suitePath),
      "--predictions", packageRef(rerunBasePredictionsPath),
      "--system-run-manifest", packageRef(rerunSystemManifestPath),
      "--recovery-manifest", packageRef(rerunRecoveryManifestPath),
      "--ungated-system", requireString(input.gateRoles.ungated, "ungated role"),
      "--checklist-system", requireString(input.gateRoles.checklist, "checklist role"),
      "--manuscript-system", requireString(input.gateRoles.manuscript, "manuscript role"),
      "--full-system", requireString(input.gateRoles.full, "full role"),
      "--out-dir", packageRef(gateOut)
    ];
    for (const run of input.sourceRuns) {
      args.push("--provider-run-manifest", requireString(run.manifest_path, "provider run path"));
    }
    for (const ablation of requireArray(input.gateRoles.ablations, "ablation roles")) {
      args.push("--ablation-system", requireString(ablation, "ablation role"));
    }
    runCommand(process.execPath, args, ROOT, "confirmatory verification CLI", [0, 1]);

    const rerunGate = requireRecord(
      await readJson(path.join(gateOut, "promotion-confirmatory-gate.json")),
      "rerun confirmatory gate"
    );
    const rerunScore = requireRecord(
      await readJson(path.join(gateOut, "score", "promotion-score.json")),
      "rerun score report"
    );
    const rerunProvider = requireRecord(
      await readJson(path.join(gateOut, "provider-aggregate", "provider-run-aggregate-manifest.json")),
      "rerun provider aggregate"
    );
    const rerunRecovery = requireRecord(
      await readJson(path.join(gateOut, "recovery", "promotion-recovery-report.json")),
      "rerun recovery report"
    );
    expectDeepEqual(
      normalizePredictions(await readJsonLines(path.join(gateOut, "scored-predictions.jsonl"))),
      normalizePredictions(await readJsonLines(input.scoredPredictionsPath)),
      "Rerun scored predictions"
    );

    expectDeepEqual(normalizeScore(rerunScore), normalizeScore(input.score),
      "Deterministic score report");
    expectDeepEqual(normalizeProvider(rerunProvider), normalizeProvider(input.providerAggregate),
      "Provider aggregate");
    expectDeepEqual(normalizeRecovery(rerunRecovery), normalizeRecovery(input.recoveryReport),
      "Recovery report");
    expectDeepEqual(normalizeGate(rerunGate), normalizeGate(input.gate),
      "Confirmatory gate");
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true });
  }
}

async function buildVerificationRuntime() {
  const root = await fs.mkdtemp(path.join(ROOT, ".audit-runtime-v1-"));
  try {
    const tscPath = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
    await requireRegularFile(tscPath, "Package-local TypeScript compiler");
    const distRoot = path.join(root, "dist");
    runCommand(
      process.execPath,
      [
        tscPath,
        "-p", path.join(ROOT, "tsconfig.json"),
        "--outDir", distRoot,
        "--declaration", "false",
        "--sourceMap", "false"
      ],
      ROOT,
      "isolated hash-bound source build"
    );
    const benchmarkModulePath = path.join(distRoot, "core", "benchmark", "promotionBenchmark.js");
    const cliPath = path.join(distRoot, "cli", "main.js");
    await requireRegularFile(benchmarkModulePath, "Isolated benchmark module");
    await requireRegularFile(cliPath, "Isolated AutoLabOS CLI");
    return { root, benchmarkModulePath, cliPath };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function verifyReferenceReviewProjection() {
  const submissionStatus = requireRecord(
    await readJson(resolvePortablePath("paper/submission_status.json")),
    "paper submission status"
  );
  const referenceEvidence = optionalRecord(submissionStatus.reference_evidence);
  const handoff = optionalRecord(referenceEvidence?.review_handoff);
  const packageManifestRef = handoff?.manifest_package_ref;
  if (packageManifestRef === undefined) return { status: "not_declared" };
  expect(packageManifestRef === "paper/reference-review-handoff/package-manifest.json",
    "Reference review package manifest path is not canonical.");
  const projection = requireRecord(
    await readJson(resolvePortablePath(packageManifestRef)),
    "reference review package projection"
  );
  expect(projection.schema_version === "1.0", "Unsupported reference review package projection schema.");
  const sourceManifestBinding = requireRecord(
    projection.source_manifest,
    "reference review source manifest binding"
  );
  expect(sourceManifestBinding.package_ref === "paper/reference-review-handoff/source-manifest.json",
    "Reference review source manifest package path is not canonical.");
  expect(sourceManifestBinding.source_ref === handoff.manifest_source_ref,
    "Reference review source manifest source_ref disagrees with submission status.");
  const sourceManifest = requireRecord(
    await readJson(resolvePortablePath(sourceManifestBinding.package_ref)),
    "reference review source manifest"
  );
  expect(sourceManifest.schema_version === "1.0", "Unsupported reference review source manifest schema.");
  expect(projection.handoff_id === sourceManifest.handoff_id,
    "Reference review handoff_id disagrees with its source manifest.");

  const manuscript = requireRecord(projection.manuscript, "reference review manuscript binding");
  expect(manuscript.source_ref === sourceManifest.manuscript_ref
    && manuscript.package_ref === "paper/main.tex",
  "Reference review manuscript mapping disagrees with its source manifest.");

  const destinationByRole = {
    claims: "paper/refgate_claims.tsv",
    status: "paper/reference_evidence_status.json",
    lock: "paper/refgate.lock.json"
  };
  const sourceInputs = requireArray(sourceManifest.source_inputs, "reference review source manifest inputs")
    .map((value) => requireRecord(value, "reference review source input"));
  const projectedInputs = requireArray(projection.source_inputs, "reference review source inputs")
    .map((value) => requireRecord(value, "reference review projected input"));
  expect(sourceInputs.length === projectedInputs.length,
    "Reference review source input count disagrees with its source manifest.");
  for (const sourceInput of sourceInputs) {
    const role = requireString(sourceInput.role, "reference review source input role");
    const projected = projectedInputs.find((value) => value.role === role);
    expect(Boolean(projected), "Reference review projected input role is missing: " + role);
    expect(projected.source_ref === sourceInput.ref
      && projected.package_ref === destinationByRole[role]
      && projected.sha256 === sourceInput.sha256,
    "Reference review projected input mapping disagrees for role: " + role);
  }

  const sourceFiles = requireArray(sourceManifest.files, "reference review source manifest files")
    .map((value) => requireRecord(value, "reference review source file"));
  const projectedFiles = requireArray(projection.reviewer_files, "reference review files")
    .map((value) => requireRecord(value, "reference review projected file"));
  expect(sourceFiles.length === projectedFiles.length,
    "Reference review reviewer-file count disagrees with its source manifest.");
  const sourceManifestDir = path.posix.dirname(requireString(
    sourceManifestBinding.source_ref,
    "reference review source manifest source_ref"
  ));
  for (const sourceFile of sourceFiles) {
    const relativeRef = requireString(sourceFile.path, "reference review source file path");
    const sourceRef = path.posix.normalize(path.posix.join(sourceManifestDir, relativeRef));
    const packageRef = path.posix.normalize(path.posix.join("paper/reference-review-handoff", relativeRef));
    const projected = projectedFiles.find((value) => value.package_ref === packageRef);
    expect(Boolean(projected), "Reference review projected reviewer file is missing: " + relativeRef);
    expect(projected.source_ref === sourceRef && projected.sha256 === sourceFile.sha256,
      "Reference review projected reviewer mapping disagrees: " + relativeRef);
  }

  const bindings = [sourceManifestBinding, manuscript, ...projectedInputs, ...projectedFiles];
  for (const raw of bindings) {
    const value = requireRecord(raw, "reference review projection binding");
    const binding = {
      path: requireString(value.package_ref, "reference review package path"),
      sha256: requireSha256(value.sha256, "reference review package SHA-256"),
      bytes: requireInteger(value.bytes, "reference review package bytes")
    };
    await verifyBinding(binding);
  }
  expect(referenceEvidence.status_artifact_package_ref === "paper/reference_evidence_status.json",
    "Reference evidence status package path is not canonical.");
  return { status: "passed", binding_count: bindings.length };
}

function normalizeScore(value) {
  const copy = clone(value);
  delete copy.generated_at;
  copy.suite_ref = "<suite>";
  copy.prediction_ref = "<predictions>";
  for (const system of requireArray(copy.systems, "score systems")) {
    delete requireRecord(system, "score system").mean_latency_ms;
  }
  return copy;
}

function normalizeSystemRun(value) {
  const copy = clone(value);
  delete copy.generated_at;
  copy.suite_path = "<suite>";
  const artifacts = requireRecord(copy.artifacts, "system run artifacts");
  artifacts.predictions_path = "<predictions>";
  artifacts.predictions_sha256 = "<runtime-dependent-latency>";
  return copy;
}

function normalizePredictions(predictions) {
  return predictions.map((raw) => {
    const prediction = clone(requireRecord(raw, "prediction"));
    delete prediction.latency_ms;
    return prediction;
  });
}

function normalizeProvider(value) {
  const copy = clone(value);
  delete copy.generated_at;
  requireRecord(copy.artifacts, "provider artifacts").predictions_path = "<predictions>";
  return copy;
}

function normalizeRecovery(value) {
  const copy = clone(value);
  delete copy.generated_at;
  for (const key of [
    "recovery_manifest_sha256",
    "original_predictions_sha256",
    "repaired_predictions_sha256",
    "original_system_run_manifest_sha256",
    "repaired_system_run_manifest_sha256",
    "repair_execution_manifest_sha256"
  ]) {
    requireSha256(copy[key], "recovery report " + key);
    copy[key] = "<runtime-dependent>";
  }
  return copy;
}

function normalizeRecoveryManifest(value) {
  const copy = clone(value);
  for (const key of [
    "original_suite_path",
    "repaired_suite_path",
    "original_predictions_path",
    "repaired_predictions_path",
    "original_system_run_manifest_path",
    "repaired_system_run_manifest_path",
    "repair_execution_manifest_path"
  ]) {
    requireString(copy[key], "recovery manifest " + key);
    copy[key] = "<package-relative>";
  }
  return copy;
}

function normalizeRepairExecution(value) {
  const copy = clone(value);
  delete copy.generated_at;
  for (const key of [
    "source_predictions_sha256",
    "repaired_predictions_sha256",
    "source_system_run_manifest_sha256",
    "repaired_system_run_manifest_sha256"
  ]) {
    requireSha256(copy[key], "repair execution " + key);
    copy[key] = "<runtime-dependent>";
  }
  for (const rawAttempt of requireArray(copy.attempts, "repair attempts")) {
    const attempt = requireRecord(rawAttempt, "repair attempt");
    delete attempt.started_at;
    delete attempt.completed_at;
    requireSha256(attempt.source_prediction_sha256, "repair source prediction hash");
    attempt.source_prediction_sha256 = "<runtime-dependent>";
  }
  return copy;
}

function normalizeGate(value) {
  const copy = clone(value);
  delete copy.generated_at;
  const artifacts = requireRecord(copy.artifacts, "gate artifacts");
  copy.artifacts = {
    suite_sha256: artifacts.suite_sha256,
    suite_snapshot_sha256: artifacts.suite_snapshot_sha256,
    input_predictions_sha256: normalizedRuntimeHash(artifacts.input_predictions_sha256, "input predictions"),
    scored_predictions_sha256: normalizedRuntimeHash(artifacts.scored_predictions_sha256, "scored predictions"),
    score_report_ref: normalizedReplayRef(artifacts.score_report_ref, "score report"),
    score_report_sha256: normalizedRuntimeHash(artifacts.score_report_sha256, "score report"),
    system_run_manifest_ref: normalizedReplayRef(artifacts.system_run_manifest_ref, "system run manifest"),
    system_run_manifest_sha256: normalizedRuntimeHash(artifacts.system_run_manifest_sha256, "system run manifest"),
    provider_aggregate_ref: normalizedReplayRef(artifacts.provider_aggregate_ref, "provider aggregate"),
    provider_aggregate_sha256: normalizedRuntimeHash(artifacts.provider_aggregate_sha256, "provider aggregate"),
    recovery_report_ref: normalizedReplayRef(artifacts.recovery_report_ref, "recovery report"),
    recovery_report_sha256: normalizedRuntimeHash(artifacts.recovery_report_sha256, "recovery report")
  };
  return copy;
}

function normalizedRuntimeHash(value, label) {
  if (value === null) return null;
  requireSha256(value, label + " SHA-256");
  return "<runtime-dependent:" + label + ">";
}

function normalizedReplayRef(value, label) {
  if (value === null) return null;
  return path.basename(requireString(value, label + " ref"));
}

function verifyProjectedResultRows(rows, score, gate, providerTrialCount) {
  const systems = new Map(requireArray(score.systems, "score systems").map((raw) => {
    const system = requireRecord(raw, "score system");
    return [requireString(system.system_id, "score system ID"), system];
  }));
  const checklist = systems.get(requireString(gate.system_roles.checklist, "checklist role"));
  const ungated = systems.get(requireString(gate.system_roles.ungated, "ungated role"));
  const full = systems.get(requireString(gate.system_roles.full, "full role"));
  expect(Boolean(checklist) && Boolean(ungated) && Boolean(full), "Projected result roles are absent from score systems.");
  const specs = [
    ["false_paper_ready_rate", checklist, full, "false_paper_ready_rate", full.prediction_count - full.clean_case_count],
    ["clean_case_promotion_accuracy", checklist, full, "clean_case_promotion_accuracy", full.clean_case_count],
    ["exact_decision_accuracy", checklist, full, "exact_decision_accuracy", full.prediction_count],
    ["repair_owner_exact_match_accuracy", ungated, full, "repair_owner_exact_match_accuracy", full.repair_owner_eligible_count]
  ];
  expect(rows.length === specs.length, "Projected result row count is not the declared comparison set.");
  for (let index = 0; index < specs.length; index += 1) {
    const row = requireRecord(rows[index], "projected result row " + String(index + 1));
    const [metric, baselineSystem, comparatorSystem, field, eligibleCount] = specs[index];
    const baseline = requireFiniteNumber(baselineSystem[field], metric + " baseline source");
    const comparator = requireFiniteNumber(comparatorSystem[field], metric + " comparator source");
    expect(row.metric === metric
      && row.baseline_system_id === baselineSystem.system_id
      && row.comparator_system_id === comparatorSystem.system_id,
    "Projected result row endpoints do not match score roles: " + metric);
    expect(row.baseline === baseline && row.comparator === comparator
      && row.delta === comparator - baseline,
    "Projected result row values do not match source score: " + metric);
    expect(row.contrast === "comparator_minus_baseline"
      && row.eligible_case_count === eligibleCount
      && row.base_bundle_count === gate.base_bundle_count,
    "Projected result row denominator or contrast is invalid: " + metric);
    expect(row.source_trial_count === Math.min(baselineSystem.trial_count, comparatorSystem.trial_count)
      && row.provider_receipt_trial_count === providerTrialCount
      && row.provider_receipts_are_statistical_replicates === false,
    "Projected result row conflates benchmark trials with provider receipts: " + metric);
  }
}

function verifyExpectedCounts(manifest, actual) {
  const expected = requireRecord(manifest.semantic_expectations, "semantic expectations");
  for (const [key, value] of Object.entries(actual)) {
    expect(Object.prototype.hasOwnProperty.call(expected, key),
      "Projection manifest is missing semantic expectation: " + key);
    expect(expected[key] === value,
      "Semantic expectation mismatch for " + key + ": expected "
        + String(expected[key]) + ", observed " + String(value));
  }
}

async function inspectCorpusBoundary(manifest) {
  let seedHashManifestCount = 0;
  let seedMaterialRecordCount = 0;
  for (const raw of manifest.files) {
    const binding = parseBinding(raw, "projection manifest");
    if (!binding.path.endsWith(".json") || binding.bytes > 10_000_000) continue;
    let value;
    try {
      value = await readJson(resolvePortablePath(binding.path));
    } catch {
      continue;
    }
    const state = { hashes: 0, seeds: 0 };
    inspectSeedFields(value, state);
    seedHashManifestCount += state.hashes;
    seedMaterialRecordCount += state.seeds;
  }
  if (seedHashManifestCount > 0 && seedMaterialRecordCount === 0) {
    return {
      status: "artifact_verification_only_seed_preimage_unavailable",
      seed_hash_manifest_count: seedHashManifestCount,
      corpus_regeneration_performed: false,
      explanation: "Only one-way seed hashes are retained; they cannot regenerate the source corpus."
    };
  }
  return {
    status: seedMaterialRecordCount > 0
      ? "artifact_verification_only_seed_material_present"
      : "artifact_verification_only_no_seed_commitment_discovered",
    seed_hash_manifest_count: seedHashManifestCount,
    corpus_regeneration_performed: false,
    explanation: "This verifier checks frozen package artifacts and does not regenerate a corpus."
  };
}

function inspectSeedFields(value, state) {
  if (Array.isArray(value)) {
    for (const item of value) inspectSeedFields(item, state);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (isSha256(value.seed_sha256)) state.hashes += 1;
  if (typeof value.seed === "string" && value.seed.length > 0) state.seeds += 1;
  for (const child of Object.values(value)) inspectSeedFields(child, state);
}

async function rebuildPdf() {
  const sourcePaper = resolvePortablePath("paper");
  const mainTex = path.join(sourcePaper, "main.tex");
  const originalPdf = path.join(sourcePaper, "main.pdf");
  await requireRegularFile(mainTex, "paper/main.tex");
  await requireRegularFile(originalPdf, "paper/main.pdf");
  const layout = await verifyPaperLayoutReceipt(sourcePaper);
  const tempRoot = await fs.mkdtemp(path.join(ROOT, ".paper-rebuild-v1-"));
  try {
    const buildRoot = path.join(tempRoot, "paper");
    await fs.cp(sourcePaper, buildRoot, { recursive: true, dereference: false });
    for (const name of [
      "main.pdf", "main.aux", "main.bbl", "main.blg", "main.fdb_latexmk",
      "main.fls", "main.log", "main.out", "main.run.xml"
    ]) {
      await fs.rm(path.join(buildRoot, name), { force: true });
    }
    const tex = await fs.readFile(path.join(buildRoot, "main.tex"), "utf8");
    let buildTool;
    if (commandExists("latexmk", ["-v"])) {
      runCommand(
        "latexmk",
        ["-pdf", "-interaction=nonstopmode", "-halt-on-error", "main.tex"],
        buildRoot,
        "latexmk PDF rebuild"
      );
      buildTool = "latexmk";
    } else {
      expect(commandExists("pdflatex", ["--version"]),
        "PDF rebuild requires latexmk or pdflatex.");
      runCommand(
        "pdflatex",
        ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "main.tex"],
        buildRoot,
        "initial pdflatex pass"
      );
      if (/\\addbibresource\s*\{/u.test(tex) || /\\printbibliography/u.test(tex)) {
        expect(commandExists("biber", ["--version"]),
          "The manuscript uses biblatex and requires biber.");
        runCommand("biber", ["main"], buildRoot, "biber bibliography pass");
      } else if (/\\bibliography\s*\{/u.test(tex)) {
        expect(commandExists("bibtex", ["--version"]),
          "The manuscript uses BibTeX and requires bibtex.");
        runCommand("bibtex", ["main"], buildRoot, "bibtex bibliography pass");
      }
      runCommand(
        "pdflatex",
        ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "main.tex"],
        buildRoot,
        "second pdflatex pass"
      );
      runCommand(
        "pdflatex",
        ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "main.tex"],
        buildRoot,
        "final pdflatex pass"
      );
      buildTool = "pdflatex";
    }
    const rebuiltPdf = path.join(buildRoot, "main.pdf");
    await requireRegularFile(rebuiltPdf, "rebuilt paper/main.pdf");
    const bytes = await fs.readFile(rebuiltPdf);
    expect(bytes.subarray(0, 5).toString("ascii") === "%PDF-",
      "Rebuilt paper/main.pdf does not have a PDF header.");
    const rebuiltLog = await fs.readFile(path.join(buildRoot, "main.log"), "utf8");
    expect(!/undefined citations?|citation.+undefined/iu.test(rebuiltLog),
      "Rebuilt paper contains undefined citations.");
    expect(!/undefined references?|reference.+undefined/iu.test(rebuiltLog),
      "Rebuilt paper contains undefined references.");
    expect(!/overfull \\[hv]box/iu.test(rebuiltLog),
      "Rebuilt paper contains overfull boxes.");
    expect(commandExists("pdfinfo", ["-v"]) && commandExists("pdftotext", ["-v"]),
      "PDF verification requires pdfinfo and pdftotext.");
    const pdfInfo = runCommand("pdfinfo", ["main.pdf"], buildRoot, "pdfinfo");
    const pageMatch = String(pdfInfo.stdout || "").match(/^Pages:\s+(\d+)$/mu);
    expect(Boolean(pageMatch) && Number(pageMatch[1]) === layout.page_count,
      "Rebuilt PDF page count disagrees with layout validation.");
    runCommand("pdftotext", ["main.pdf", "main.txt"], buildRoot, "pdftotext");
    const extractedText = await fs.readFile(path.join(buildRoot, "main.txt"), "utf8");
    expect(extractedText.trim().length >= 500,
      "Rebuilt PDF text extraction is unexpectedly empty.");
    return {
      status: "passed",
      build_tool: buildTool,
      rebuilt_bytes: bytes.byteLength,
      source_pdf_sha256: await sha256File(originalPdf),
      rebuilt_pdf_sha256: sha256Bytes(bytes),
      byte_identity_required: false
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function artifactPath(rawRef, rawHash, label) {
  const ref = requireString(rawRef, label + " path");
  const expectedHash = requireSha256(rawHash, label + " SHA-256");
  const absolute = resolvePortablePath(ref);
  const actualHash = await sha256File(absolute);
  expect(actualHash === expectedHash, label + " SHA-256 mismatch.");
  return absolute;
}

async function boundPathByHash(manifest, rawHash, label) {
  const hash = requireSha256(rawHash, label + " SHA-256");
  const matches = manifest.files
    .map((value) => parseBinding(value, "projection manifest"))
    .filter((binding) => binding.sha256 === hash);
  expect(matches.length > 0, "Projection manifest does not contain " + label + ".");
  const selected = [...matches].sort((left, right) => left.path.localeCompare(right.path))[0];
  await verifyBinding(selected);
  return resolvePortablePath(selected.path);
}

function parseBinding(value, label) {
  const record = requireRecord(value, label + " binding");
  return {
    path: requireString(record.path, label + " path"),
    sha256: requireSha256(record.sha256, label + " SHA-256"),
    bytes: requireInteger(record.bytes, label + " bytes")
  };
}

async function verifyBinding(binding) {
  const absolute = resolvePortablePath(binding.path);
  const stat = await requireRegularFile(absolute, "Bound file " + binding.path);
  expect(stat.size === binding.bytes, "Byte count mismatch: " + binding.path);
  expect(await sha256File(absolute) === binding.sha256, "SHA-256 mismatch: " + binding.path);
}

function resolvePortablePath(ref) {
  const value = requireString(ref, "portable path");
  expect(!value.includes("\\") && !path.isAbsolute(value), "Unsafe package path: " + value);
  expect(path.posix.normalize(value) === value && value !== "." && value !== ".."
    && !value.startsWith("../"), "Non-canonical package path: " + value);
  const absolute = path.resolve(ROOT, ...value.split("/"));
  const relative = path.relative(ROOT, absolute);
  expect(relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)),
    "Package path escapes root: " + value);
  return absolute;
}

function resolveRelativePortablePath(baseFilePath, ref) {
  const value = requireString(ref, "relative portable path");
  expect(!value.includes("\\") && !path.isAbsolute(value), "Unsafe relative package path: " + value);
  const absolute = path.resolve(path.dirname(baseFilePath), ...value.split("/"));
  const relative = path.relative(ROOT, absolute);
  expect(relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    "Relative package path escapes root: " + value);
  return absolute;
}

function packageRef(absolute) {
  const relative = path.relative(ROOT, absolute);
  expect(relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    "Verification output or input must stay inside the package root.");
  return relative.split(path.sep).join("/");
}

async function requireRegularFile(filePath, label) {
  const stat = await fs.lstat(filePath);
  expect(stat.isFile() && !stat.isSymbolicLink(), label + " must be a regular non-symlink file.");
  return stat;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readJsonLines(filePath) {
  return (await fs.readFile(filePath, "utf8"))
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

async function sha256File(filePath) {
  return sha256Bytes(await fs.readFile(filePath));
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashSystemRuntimeSourceTree(root) {
  const rows = [];
  const visit = async (absolutePath, relativePath) => {
    const stat = await fs.lstat(absolutePath);
    expect(!stat.isSymbolicLink(),
      "Packaged execution source contains a symbolic link: " + relativePath);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(absolutePath, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!isReproducibleSourceEntry(entry.name)) continue;
        await visit(path.join(absolutePath, entry.name), path.posix.join(relativePath, entry.name));
      }
      return;
    }
    if (stat.isFile()) rows.push({ ref: relativePath, sha256: await sha256File(absolutePath) });
  };
  for (const ref of RUNTIME_SOURCE_ROOTS) await visit(path.join(root, ref), ref);
  return sha256Bytes(Buffer.from(JSON.stringify(rows) + "\n", "utf8"));
}

function isReproducibleSourceEntry(name) {
  const normalized = name.toLowerCase();
  return !TRANSIENT_SOURCE_FILENAMES.has(normalized)
    && !name.startsWith(".#")
    && !name.endsWith("~")
    && !TRANSIENT_SOURCE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function commandExists(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 20 * 1024 * 1024
  });
  return !(result.error && result.error.code === "ENOENT");
}

function runCommand(command, args, cwd, label, allowedStatuses = [0]) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.error || !allowedStatuses.includes(result.status)) {
    const detail = [result.stdout, result.stderr]
      .filter((value) => typeof value === "string" && value.trim())
      .join("\n")
      .slice(-8000);
    throw new Error(label + " failed" + (detail ? ":\n" + detail : "."));
  }
  return result;
}

function expectDeepEqual(actual, expected, label) {
  expect(isDeepStrictEqual(actual, expected), label + " changed under deterministic replay.");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function requireRecord(value, label) {
  expect(Boolean(value) && typeof value === "object" && !Array.isArray(value),
    label + " must be an object.");
  return value;
}

function optionalRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function requireArray(value, label) {
  expect(Array.isArray(value), label + " must be an array.");
  return value;
}

function requireString(value, label) {
  expect(typeof value === "string" && value.length > 0, label + " must be a non-empty string.");
  return value;
}

function requireInteger(value, label) {
  expect(Number.isInteger(value) && value >= 0, label + " must be a non-negative integer.");
  return value;
}

function requireFiniteNumber(value, label) {
  expect(typeof value === "number" && Number.isFinite(value), label + " must be a finite number.");
  return value;
}

function requireSha256(value, label) {
  expect(isSha256(value), label + " must be a SHA-256 digest.");
  return value;
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function issueCodes(issues) {
  return Array.isArray(issues)
    ? issues.map((value) => value && typeof value === "object" && typeof value.code === "string"
      ? value.code
      : "unknown").join(", ")
    : "unknown";
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
`;
}

function requiredBinding(bindings: SupportBinding[], relativePath: string): SupportBinding {
  const binding = bindings.find((candidate) => candidate.path === relativePath);
  if (!binding) throw new Error("Generated audit-package file is missing: " + relativePath);
  return binding;
}

function nonNegativeIntegerValue(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : null;
}


function assertEligibleGate(gate: PromotionConfirmatoryGateReport): void {
  if (gate.schema_version !== "1.3"
      || gate.readiness !== "paper_scale_candidate"
      || gate.paper_ready !== false
      || gate.study_design !== "post_hoc_fixed_suite_conformance"
      || gate.claim_class !== "fixed_suite_conformance_signal"
      || !gate.score_validation_passed
      || gate.evidence_gate_passed
      || gate.evidence_gate_reason !== "post_hoc_design_not_prospective_evidence"
      || !gate.conformance_gate_passed
      || gate.blockers.length > 0
      || gate.claim_ceiling !== "registered_fault_families_only"
      || gate.provider_repetition.status !== "verified_receipt_distinct"
      || gate.provider_repetition.trial_count !== 3
      || gate.recovery.status !== "verified") {
    throw new Error("The post-hoc conformance gate is not eligible for a standard paper-scale candidate audit package.");
  }
}

function assertScoreMatchesGate(
  score: PromotionBenchmarkScoreReport,
  gate: PromotionConfirmatoryGateReport
): void {
  if (!score.passed
      || score.suite_id !== gate.suite_id
      || score.case_count !== gate.case_count
      || score.evaluation_regime !== gate.evaluation_regime
      || score.claim_ceiling !== gate.claim_ceiling
      || score.external_validation_status !== gate.external_validation_status) {
    throw new Error("Score report does not match the passed confirmatory gate.");
  }
}

function assertProviderAggregate(
  aggregate: PromotionProviderAggregateManifest,
  gate: PromotionConfirmatoryGateReport
): void {
  if (aggregate.status !== "completed"
      || aggregate.trial_count !== gate.provider_repetition.trial_count
      || aggregate.source_runs.length !== aggregate.trial_count
      || !aggregate.receipt_distinct_trial_requirement_met
      || aggregate.receipt_distinctness.statistical_independence_established !== false
      || aggregate.receipt_distinctness.statistical_replicates !== false
      || aggregate.suite_id !== gate.suite_id
      || aggregate.system_id !== gate.system_roles.manuscript) {
    throw new Error("Provider aggregate does not satisfy the confirmatory repetition contract.");
  }
}

function buildResultRows(
  score: PromotionBenchmarkScoreReport,
  gate: PromotionConfirmatoryGateReport
): ProjectedResultRow[] {
  const checklist = findSystem(score, gate.system_roles.checklist);
  const ungated = findSystem(score, gate.system_roles.ungated);
  const full = findSystem(score, gate.system_roles.full);
  return [
    resultRow("false_paper_ready_rate", checklist, full, requiredMetric(checklist.false_paper_ready_rate), requiredMetric(full.false_paper_ready_rate), "lower_better", full.prediction_count - full.clean_case_count, gate),
    resultRow("clean_case_promotion_accuracy", checklist, full, requiredMetric(checklist.clean_case_promotion_accuracy), requiredMetric(full.clean_case_promotion_accuracy), "higher_better", full.clean_case_count, gate),
    resultRow("exact_decision_accuracy", checklist, full, checklist.exact_decision_accuracy, full.exact_decision_accuracy, "higher_better", full.prediction_count, gate),
    resultRow("repair_owner_exact_match_accuracy", ungated, full, requiredMetric(ungated.repair_owner_exact_match_accuracy), requiredMetric(full.repair_owner_exact_match_accuracy), "higher_better", full.repair_owner_eligible_count, gate)
  ];
}

function resultRow(
  metric: string,
  baselineSystem: PromotionBenchmarkSystemMetrics,
  comparatorSystem: PromotionBenchmarkSystemMetrics,
  baseline: number,
  comparator: number,
  direction: ProjectedResultRow["direction"],
  eligibleCaseCount: number,
  gate: PromotionConfirmatoryGateReport
): ProjectedResultRow {
  return {
    metric,
    baseline_system_id: baselineSystem.system_id,
    comparator_system_id: comparatorSystem.system_id,
    baseline,
    comparator,
    delta: comparator - baseline,
    direction,
    contrast: "comparator_minus_baseline",
    eligible_case_count: eligibleCaseCount,
    base_bundle_count: gate.base_bundle_count,
    source_trial_count: Math.min(baselineSystem.trial_count, comparatorSystem.trial_count),
    provider_receipt_trial_count: gate.provider_repetition.trial_count,
    provider_receipts_are_statistical_replicates: false
  };
}

async function auditManuscriptTable(
  manuscriptPath: string,
  score: PromotionBenchmarkScoreReport,
  gate: PromotionConfirmatoryGateReport
): Promise<{
  audited_at: string;
  figure_count: number;
  table_count: number;
  checked_result_row_count: number;
  issues: string[];
  severe_mismatch_count: number;
  review_block_required: boolean;
}> {
  const manuscript = await fs.readFile(manuscriptPath, "utf8");
  const issues: string[] = [];
  const expectedSystems = [
    gate.system_roles.ungated,
    gate.system_roles.checklist,
    ...gate.system_roles.ablations,
    gate.system_roles.manuscript,
    gate.system_roles.full
  ].map((systemId) => findSystem(score, systemId));
  const expectedMetricCount = 8;
  const tableCandidates = [...manuscript.matchAll(/\\begin\{table\*?\}[\s\S]*?\\end\{table\*?\}/gu)]
    .map((match) => {
      const body = match[0].match(/\\midrule([\s\S]*?)\\bottomrule/u)?.[1];
      const rows = (body ?? "").split("\n")
        .map((line) => line.trim())
        .filter((line) => line.includes("&") && line.includes("\\\\"));
      const shapeMatchCount = rows.filter((row) => (
        row.replace(/\\\\.*$/u, "").split("&").length === expectedMetricCount + 1
      )).length;
      return { rows, shapeMatchCount };
    })
    .filter((candidate) => candidate.shapeMatchCount > 0)
    .sort((left, right) => {
      const shapeDifference = right.shapeMatchCount - left.shapeMatchCount;
      if (shapeDifference !== 0) return shapeDifference;
      return Math.abs(left.rows.length - expectedSystems.length)
        - Math.abs(right.rows.length - expectedSystems.length);
    });
  const resultRows = tableCandidates[0]?.rows;
  let checkedResultRowCount = 0;
  if (!resultRows) {
    issues.push("The benchmark results table could not be located in the manuscript.");
  } else {
    if (resultRows.length !== expectedSystems.length) {
      issues.push(`Expected ${expectedSystems.length} result rows but found ${resultRows.length}.`);
    }
    for (let index = 0; index < Math.min(resultRows.length, expectedSystems.length); index += 1) {
      const fields = resultRows[index].replace(/\\\\.*$/u, "").split("&").map((field) => field.trim());
      const actual = fields.slice(1).map(parseDisplayedMetric);
      const system = expectedSystems[index];
      const expected: Array<number | null> = [
        system.trial_count,
        system.exact_decision_accuracy,
        system.macro_decision_f1,
        system.false_paper_ready_rate,
        system.clean_case_promotion_accuracy,
        system.blocker_f1,
        system.repair_owner_exact_match_accuracy,
        system.trace_coverage
      ];
      if (actual.length !== expected.length || actual.some((value, fieldIndex) => !displayMetricMatches(value, expected[fieldIndex]))) {
        issues.push(`Result row ${index + 1} does not match its hash-bound score metrics.`);
      } else {
        checkedResultRowCount += 1;
      }
    }
  }
  return {
    audited_at: new Date().toISOString(),
    figure_count: (manuscript.match(/\\begin\{figure\*?\}/gu) || []).length,
    table_count: (manuscript.match(/\\begin\{table\*?\}/gu) || []).length,
    checked_result_row_count: checkedResultRowCount,
    issues,
    severe_mismatch_count: issues.length,
    review_block_required: issues.length > 0
  };
}

function parseDisplayedMetric(value: string): number | null | undefined {
  if (/^(?:--|---|n\/a)$/iu.test(value)) return null;
  const normalized = value.startsWith(".") ? `0${value}` : value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function displayMetricMatches(actual: number | null | undefined, expected: number | null): boolean {
  if (actual === undefined) return false;
  if (actual === null || expected === null) return actual === expected;
  return Math.abs(actual - expected) <= 0.00051;
}

function findSystem(score: PromotionBenchmarkScoreReport, systemId: string): PromotionBenchmarkSystemMetrics {
  const system = score.systems.find((candidate) => candidate.system_id === systemId);
  if (!system) throw new Error(`Score report is missing declared system role: ${systemId}`);
  return system;
}

function requiredMetric(value: number | null): number {
  if (value === null) throw new Error("A required comparison metric is undefined.");
  return value;
}

function normalizeSupportedClaims(claimMap: ClaimMap): Array<{
  claim_id: string;
  statement: string;
  status: string;
  artifact_refs: string[];
  citation_refs: string[];
  evidence_ids: string[];
}> {
  if (!Array.isArray(claimMap.claims)) throw new Error("Claim evidence map must contain a claims array.");
  const records = claimMap.claims.map((value) => value as ClaimRecord);
  const claimIds = records.map((claim) => stringValue(claim.claim_id)).filter((value): value is string => Boolean(value));
  if (new Set(claimIds).size !== claimIds.length) {
    throw new Error("Academic claim evidence map contains duplicate claim IDs.");
  }
  return records
    .filter((claim) => supportedStatus(stringValue(claim.status)))
    .map((claim) => {
      const claimId = stringValue(claim.claim_id);
      const statement = stringValue(claim.statement) || stringValue(claim.claim);
      const artifactRefs = stringArray(claim.artifact_refs).map(normalizeSupportPath);
      if (!claimId || !statement || artifactRefs.length === 0) {
        throw new Error("Every supported claim requires an id, statement, and artifact references.");
      }
      return {
        claim_id: claimId,
        statement,
        status: stringValue(claim.status) || "supported",
        artifact_refs: artifactRefs,
        citation_refs: stringArray(claim.citation_refs),
        evidence_ids: stringArray(claim.evidence_ids)
      };
    });
}

function supportedStatus(status: string | undefined): boolean {
  return status === "supported"
    || status === "verified"
    || status === "supported_by_code_and_tests"
    || status === "supported_with_scope_limitation"
    || status === "supported_with_task_gold_mismatch"
    || status === "supported_with_local_runtime_boundary";
}

function assertClaimArtifactsBound(
  claims: Array<{ claim_id: string; artifact_refs: string[] }>,
  bindings: SupportBinding[]
): void {
  const available = new Set(bindings.map((binding) => binding.path));
  const missing = claims.flatMap((claim) => claim.artifact_refs
    .filter((artifactRef) => !available.has(artifactRef))
    .map((artifactRef) => `${claim.claim_id}:${artifactRef}`));
  if (missing.length > 0) {
    throw new Error(`Supported claim artifacts are not hash-bound by the package: ${missing.join(", ")}`);
  }
}

async function validatePaperLayoutReceipt(paperRoot: string): Promise<void> {
  const receiptPath = await resolveRegularFileInside(
    paperRoot,
    "layout-validation.json",
    paperRoot,
    "Paper layout validation"
  );
  const receipt = await readJsonFile<Record<string, unknown>>(receiptPath);
  const visual = recordValue(receipt.visual_findings);
  const artifacts = recordValue(receipt.artifacts);
  const pageCount = Number.isInteger(receipt.page_count) ? receipt.page_count as number : 0;
  const inspectedPages = sourceArrayValue(receipt.visual_pages_inspected);
  const expectedPages = Array.from({ length: pageCount }, (_, index) => index + 1);
  const bindings: Array<[string, string]> = [
    ["manuscript_tex_sha256", "manuscript.tex"],
    ["manuscript_pdf_sha256", "manuscript.pdf"],
    ["manuscript_log_sha256", "manuscript.log"],
    ["acl_sty_sha256", "acl.sty"],
    ["acl_natbib_bst_sha256", "acl_natbib.bst"],
    ["references_bib_sha256", "references.bib"]
  ];
  if (receipt.schema_version !== "1.0"
      || receipt.status !== "passed"
      || pageCount <= 0
      || JSON.stringify(inspectedPages) !== JSON.stringify(expectedPages)
      || receipt.undefined_citations !== false
      || receipt.undefined_references !== false
      || receipt.overfull_boxes !== false
      || visual?.clipping !== false
      || visual?.overlap !== false
      || visual?.table_overflow !== false
      || visual?.unreadable_content !== false
      || !artifacts) {
    throw new Error("Paper layout validation receipt is incomplete or did not pass.");
  }
  for (const [field, fileName] of bindings) {
    const filePath = await resolveRegularFileInside(paperRoot, fileName, paperRoot, `Paper file ${fileName}`);
    if (artifacts[field] !== await sha256File(filePath)) {
      throw new Error(`Paper layout validation is stale for ${fileName}.`);
    }
  }
}

async function validateModelClaimEvidenceReview(input: {
  paperRoot: string;
  evidenceRoot: string;
  evidenceBindings: SupportBinding[];
  claimMapPath: string;
  manuscriptPath: string;
  claims: Array<{
    claim_id: string;
    statement: string;
    status: string;
    artifact_refs: string[];
  }>;
  claimCeiling: string;
}): Promise<{ sha256: string }> {
  const receiptPath = await resolveRegularFileInside(
    input.paperRoot,
    "model-claim-evidence-review.json",
    input.paperRoot,
    "Model claim evidence review"
  );
  const receipt = await readJsonFile<Record<string, unknown>>(receiptPath);
  const policy = recordValue(receipt.policy);
  const reviewers = sourceArrayValue(receipt.reviewers).map(recordValue);
  const adjudicator = recordValue(receipt.adjudicator);
  if (receipt.schema_version !== "1.0"
      || receipt.review_mode !== "independent_model_semantic_validation"
      || receipt.claim_ceiling !== input.claimCeiling
      || receipt.claim_map_sha256 !== await sha256File(input.claimMapPath)
      || receipt.manuscript_sha256 !== await sha256File(input.manuscriptPath)
      || policy?.creates_empirical_evidence !== false
      || policy?.may_override_deterministic_gate !== false
      || policy?.human_authority !== false
      || reviewers.length < 2
      || reviewers.some((reviewer) => !validModelClaimReviewer(reviewer))
      || new Set(reviewers.map((reviewer) => reviewer?.reviewer_id)).size !== reviewers.length
      || new Set(reviewers.map((reviewer) => reviewer?.execution_id)).size !== reviewers.length
      || !validModelClaimReviewer(adjudicator)
      || adjudicator?.sees_all_reviewer_outputs !== true) {
    throw new Error("Model claim evidence review receipt is malformed or exceeds its authority.");
  }
  const reviewerRecords = reviewers.filter(
    (reviewer): reviewer is Record<string, unknown> => Boolean(reviewer)
  );
  for (const reviewer of [...reviewerRecords, adjudicator!]) {
    await validateModelClaimReviewerArtifacts(
      reviewer,
      input.evidenceRoot,
      input.evidenceBindings
    );
  }
  const observedHashes = stringArray(adjudicator?.observed_reviewer_output_sha256s);
  const expectedHashes = reviewerRecords.map((reviewer) => stringValue(reviewer.output_sha256));
  if (observedHashes.length !== expectedHashes.length
      || observedHashes.some((hash, index) => hash !== expectedHashes[index])) {
    throw new Error("Model claim meta-reviewer did not bind every reviewer output.");
  }
  const reviewedClaims = sourceArrayValue(receipt.claim_reviews).map(recordValue);
  const reviewedById = new Map(reviewedClaims.map((review) => [stringValue(review?.claim_id), review]));
  if (reviewedClaims.length !== input.claims.length || reviewedById.size !== input.claims.length) {
    throw new Error("Model claim evidence review does not cover the exact claim inventory.");
  }
  for (const claim of input.claims) {
    const review = reviewedById.get(claim.claim_id);
    if (!review
        || review.decision !== "supported_within_claim_ceiling"
        || review.status !== claim.status
        || review.statement_sha256 !== sha256Text(claim.statement)
        || review.artifact_refs_sha256 !== sha256CanonicalStrings(claim.artifact_refs)) {
      throw new Error(`Model claim evidence review is not bound to claim ${claim.claim_id}.`);
    }
  }
  return { sha256: await sha256File(receiptPath) };
}

function validModelClaimReviewer(value: Record<string, unknown> | undefined): boolean {
  return Boolean(value
    && stringValue(value.reviewer_id)
    && stringValue(value.role)
    && stringValue(value.provider)
    && stringValue(value.model)
    && stringValue(value.execution_id)
    && value.context_isolated === true
    && isSha256Digest(value.input_sha256)
    && isSha256Digest(value.output_sha256)
    && isSha256Digest(value.provider_receipt_sha256)
    && stringValue(value.input_ref)
    && stringValue(value.output_ref)
    && stringValue(value.provider_receipt_ref));
}

async function validateModelClaimReviewerArtifacts(
  reviewer: Record<string, unknown>,
  evidenceRoot: string,
  evidenceBindings: SupportBinding[]
): Promise<void> {
  const bound = new Map(evidenceBindings.map((binding) => [binding.path, binding]));
  const fields = [
    ["input_ref", "input_sha256"],
    ["output_ref", "output_sha256"],
    ["provider_receipt_ref", "provider_receipt_sha256"]
  ] as const;
  for (const [refField, hashField] of fields) {
    const relativePath = normalizeSupportPath(String(reviewer[refField]));
    const binding = bound.get(relativePath);
    if (!binding || binding.sha256 !== reviewer[hashField]) {
      throw new Error(`Model review artifact is not bound by the support manifest: ${relativePath}`);
    }
    const filePath = await resolveRegularFileInside(
      evidenceRoot,
      relativePath,
      evidenceRoot,
      "Model review artifact"
    );
    if (await sha256File(filePath) !== reviewer[hashField]) {
      throw new Error(`Model review artifact hash mismatch: ${relativePath}`);
    }
  }
}

function sha256Text(value: string): string {
  return sha256Bytes(Buffer.from(value, "utf8"));
}

function sha256CanonicalStrings(values: string[]): string {
  return sha256Text(JSON.stringify([...values]));
}

async function verifySupportManifest(root: string, manifest: SupportManifest): Promise<SupportBinding[]> {
  if (manifest.schema_version !== "1.0" || !Array.isArray(manifest.files)) {
    throw new Error("Support manifest must use schema_version 1.0 and contain files.");
  }
  const seen = new Set<string>();
  const bindings: SupportBinding[] = [];
  for (const raw of manifest.files) {
    const relativePath = normalizeSupportPath(raw.path);
    if (!isReproducibleSourceEntry(path.posix.basename(relativePath))) {
      throw new Error(`Support manifest contains a transient backup file: ${relativePath}`);
    }
    if (seen.has(relativePath)) throw new Error(`Duplicate support path: ${relativePath}`);
    seen.add(relativePath);
    const filePath = await resolveRegularFileInside(root, relativePath, root, `Support file ${relativePath}`);
    const bytes = await fs.readFile(filePath);
    const actual = sha256Bytes(bytes);
    if (actual !== raw.sha256 || bytes.byteLength !== raw.bytes) {
      throw new Error(`Support binding mismatch: ${relativePath}`);
    }
    bindings.push({ path: relativePath, sha256: actual, bytes: bytes.byteLength });
  }
  return bindings.sort((left, right) => left.path.localeCompare(right.path));
}

async function bindAdditionalEvidence(root: string, files: string[]): Promise<SupportBinding[]> {
  return Promise.all(files.map((filePath) => bindFile(root, filePath)));
}

async function bindProjectSnapshot(root: string): Promise<SupportBinding[]> {
  const paths = [
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vitest.config.ts",
    "run-tests.mjs",
    "README.md",
    ".env.example",
    "src",
    "tests",
    "scripts",
    "plugins",
    ".agents/plugins/marketplace.json",
    ".github/workflows/ci.yml",
    "docs",
    "benchmarks",
    "web/src",
    "web/index.html",
    "web/package.json",
    "web/package-lock.json",
    "web/tsconfig.json",
    "web/vite.config.ts"
  ];
  const bindings: SupportBinding[] = [];
  for (const relativePath of paths) {
    const absolute = path.join(root, relativePath);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Project snapshot path must not be a symlink: ${relativePath}`);
    if (stat.isFile()) bindings.push(await bindFile(root, absolute));
    else if (stat.isDirectory()) bindings.push(...await bindDirectory(root, absolute));
    else throw new Error(`Project snapshot path is not a regular file or directory: ${relativePath}`);
  }
  return mergeBindings(bindings);
}

function submissionRemainingGates(status: Record<string, unknown>): string[] {
  if (!Array.isArray(status.blocking_requirements)) {
    throw new Error("Submission status must declare blocking_requirements as an array.");
  }
  const gates = status.blocking_requirements.map((value, index) => {
    const gate = stringValue(value)?.trim();
    if (!gate) {
      throw new Error(`Submission status blocking requirement ${index + 1} must be a non-empty string.`);
    }
    return gate;
  });
  if (new Set(gates).size !== gates.length) {
    throw new Error("Submission status blocking_requirements must not contain duplicates.");
  }
  return gates;
}

async function expandEvidenceClosure(root: string, initial: SupportBinding[]): Promise<SupportBinding[]> {
  const bindings = new Map(initial.map((binding) => [binding.path, binding] as const));
  const queued = initial.filter((binding) => binding.path.endsWith(".json")).map((binding) => binding.path);
  const inspected = new Set<string>();
  while (queued.length > 0) {
    const relativePath = queued.shift();
    if (!relativePath || inspected.has(relativePath)) continue;
    inspected.add(relativePath);
    const absolutePath = path.join(root, relativePath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(absolutePath, "utf8"));
    } catch {
      continue;
    }
    for (const candidate of collectPathCandidates(parsed)) {
      const resolved = await resolveReferencedPath(root, path.dirname(absolutePath), candidate);
      if (!resolved) continue;
      const stat = await fs.lstat(resolved);
      const additions = stat.isDirectory()
        ? await bindDirectory(root, resolved)
        : stat.isFile() && !stat.isSymbolicLink()
          ? [await bindFile(root, resolved)]
          : [];
      for (const binding of additions) {
        const previous = bindings.get(binding.path);
        if (previous && (previous.sha256 !== binding.sha256 || previous.bytes !== binding.bytes)) {
          throw new Error(`Conflicting transitive evidence binding: ${binding.path}`);
        }
        if (!previous) {
          bindings.set(binding.path, binding);
          if (binding.path.endsWith(".json")) queued.push(binding.path);
        }
      }
    }
  }
  return [...bindings.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function collectPathCandidates(value: unknown): string[] {
  const candidates = new Set<string>();
  const visit = (current: unknown, key: string): void => {
    if (typeof current === "string") {
      if (looksLikePortablePath(current, key)) candidates.add(current);
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item) => visit(item, key));
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [childKey, childValue] of Object.entries(current as Record<string, unknown>)) {
      visit(childValue, childKey);
    }
  };
  visit(value, "");
  return [...candidates];
}

function looksLikePortablePath(value: string, key: string): boolean {
  if (
    !value
    || value.length > 4096
    || /[\0\r\n]/u.test(value)
    || value.includes("\\")
    || path.isAbsolute(value)
    || /^[a-z]+:\/\//iu.test(value)
    || value.split("/").some((segment) => Buffer.byteLength(segment, "utf8") > 255)
  ) return false;
  if (value.startsWith("<") && value.endsWith(">")) return false;
  return key === "cases"
    || /(?:^|_)(?:path|ref|root|file)$/u.test(key)
    || /\.(?:json|jsonl|md|tex|bib|bst|sty|ts|tsx|js|mjs|cjs|txt|log|pdf)$/iu.test(value)
    || value.startsWith("../");
}

async function resolveReferencedPath(root: string, sourceDir: string, value: string): Promise<string | null> {
  const bases = value.startsWith("outputs/")
      || value.startsWith("src/")
      || value.startsWith("tests/")
      || value.startsWith("papers/")
      || value.startsWith("docs/")
    ? [root, sourceDir]
    : [sourceDir, root];
  for (const base of bases) {
    const candidate = path.resolve(base, value);
    if (!isInsideOrEqual(root, candidate)) continue;
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) throw new Error(`Transitive evidence path must not be a symlink: ${value}`);
      if (stat.isFile() || stat.isDirectory()) return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENAMETOOLONG" && code !== "EINVAL") throw error;
    }
  }
  return null;
}

async function bindDirectory(root: string, directory: string): Promise<SupportBinding[]> {
  const bindings: SupportBinding[] = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (!isReproducibleSourceEntry(entry.name)
          || [".git", "node_modules", "__pycache__"].includes(entry.name)
          || entry.name.endsWith(".pyc")) {
        continue;
      }
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Evidence directory contains a symlink: ${absolute}`);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) bindings.push(await bindFile(root, absolute));
    }
  }
  return bindings.sort((left, right) => left.path.localeCompare(right.path));
}

function exactNodeVersionFromSystemRun(systemRunManifest: Record<string, unknown>): string {
  const runtimeBinding = recordValue(systemRunManifest.runtime_binding);
  const nodeVersion = stringValue(runtimeBinding?.node_version);
  const match = nodeVersion?.match(/^v(\d+\.\d+\.\d+)$/u);
  if (!match) {
    throw new Error("System run manifest must bind one exact Node.js version for reproducible export.");
  }
  return match[1];
}

async function bindFile(root: string, filePath: string): Promise<SupportBinding> {
  const relativePath = normalizeSupportPath(path.relative(root, filePath));
  const bytes = await fs.readFile(filePath);
  return { path: relativePath, sha256: sha256Bytes(bytes), bytes: bytes.byteLength };
}

function mergeBindings(...groups: SupportBinding[][]): SupportBinding[] {
  const byPath = new Map<string, SupportBinding>();
  for (const binding of groups.flat()) {
    const previous = byPath.get(binding.path);
    if (previous && (previous.sha256 !== binding.sha256 || previous.bytes !== binding.bytes)) {
      throw new Error(`Conflicting evidence binding: ${binding.path}`);
    }
    byPath.set(binding.path, binding);
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

async function resolveRequiredGateArtifact(
  root: string,
  ref: string | null,
  sha256: string | null,
  label: string
): Promise<string> {
  if (!ref || !sha256) throw new Error(`${label} is missing from the confirmatory gate.`);
  return resolveGateArtifact(root, ref, sha256, label);
}

async function resolveGateArtifact(root: string, ref: string, sha256: string, label: string): Promise<string> {
  const filePath = await resolveRegularFileInside(root, ref, root, label);
  if (await sha256File(filePath) !== sha256) throw new Error(`${label} SHA-256 does not match the gate.`);
  return filePath;
}

async function resolveManifestArtifact(
  root: string,
  manifest: Record<string, unknown>,
  expectedSha256: string,
  label: string
): Promise<string> {
  const artifacts = recordValue(manifest.artifacts);
  const ref = stringValue(artifacts?.predictions_path);
  const sha256 = stringValue(artifacts?.predictions_sha256);
  if (!ref || sha256 !== expectedSha256) throw new Error(`${label} binding is missing or inconsistent.`);
  return resolveGateArtifact(root, ref, expectedSha256, label);
}

async function copyBoundFile(root: string, destinationRoot: string, binding: SupportBinding): Promise<void> {
  const source = await resolveRegularFileInside(root, binding.path, root, `Bound evidence ${binding.path}`);
  const bytes = await fs.readFile(source);
  if (sha256Bytes(bytes) !== binding.sha256 || bytes.byteLength !== binding.bytes) {
    throw new Error(`Bound evidence changed during export: ${binding.path}`);
  }
  await copyFile(source, path.join(destinationRoot, binding.path));
}

async function copyFile(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function collectFileBindings(root: string, excluded: ReadonlySet<string>): Promise<SupportBinding[]> {
  const files: SupportBinding[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) {
        const relative = normalizeRelativePath(path.relative(root, absolute));
        if (!excluded.has(relative)) files.push(await bindFile(root, absolute));
      }
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function resolveRealDirectory(cwd: string, value: string, label: string): Promise<string> {
  const configured = path.resolve(cwd, value);
  const stat = await fs.lstat(configured);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory.`);
  return fs.realpath(configured);
}

async function resolveRegularFileInside(
  root: string,
  value: string,
  base: string,
  label: string
): Promise<string> {
  const configured = path.resolve(base, value);
  if (!isInsideOrEqual(root, configured)) throw new Error(`${label} escapes its allowed root.`);
  const stat = await fs.lstat(configured);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file.`);
  const real = await fs.realpath(configured);
  if (!isInsideOrEqual(root, real)) throw new Error(`${label} resolves outside its allowed root.`);
  return real;
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function regularFileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertFreshPath(value: string): Promise<void> {
  try {
    await fs.lstat(value);
    throw new Error(`Output path already exists: ${value}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function assertStrictlyInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be strictly inside cwd.`);
  }
}

function isInsideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeSupportPath(value: string): string {
  if (!value || path.isAbsolute(value) || value.includes("\\")) throw new Error(`Invalid portable path: ${value}`);
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== value) {
    throw new Error(`Invalid portable path: ${value}`);
  }
  return normalized;
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/gu, "/");
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  return sha256Bytes(await fs.readFile(filePath));
}

function portableRef(cwd: string, filePath: string): string {
  const relative = normalizeRelativePath(path.relative(cwd, filePath));
  return relative && !relative.startsWith("../") ? relative : "<external-output>";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function sourceArrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
