import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import { GRAPH_NODE_ORDER } from "../../types.js";
import {
  PROMOTION_DECISIONS,
  hashPromotionArtifactTree,
  hashPromotionBenchmarkSuiteSnapshot,
  loadPromotionBenchmarkSuite,
  type PromotionBenchmarkAdjudicationProvenance,
  type PromotionBenchmarkCaseManifest,
  type PromotionBenchmarkEvidenceClass,
  type PromotionBenchmarkExecutionProvenanceStatus,
  type PromotionBenchmarkSourceSuiteEvidence,
  type PromotionDecision
} from "./promotionBenchmark.js";
import {
  inspectPromotionSourceDiversity,
  type PromotionBenchmarkSourceDiversityStatus
} from "./promotionBenchmarkSourceDiversity.js";
import {
  validateVerifiedPromotionMutationAuditReport,
  type PromotionMutationAuditIssue
} from "./promotionBenchmarkMutationAudit.js";
import {
  MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES,
  MINIMUM_PROMOTION_PAPER_ELIGIBLE_CASES,
  REQUIRED_CONFIRMATORY_MUTATION_FAMILIES
} from "./promotionBenchmarkConfirmatoryContract.js";

export { REQUIRED_CONFIRMATORY_MUTATION_FAMILIES } from "./promotionBenchmarkConfirmatoryContract.js";

export interface ExportPromotionAnnotationPackInput {
  cwd: string;
  suitePath: string;
  outDir: string;
}

export interface ExportPromotionAnnotationPackResult {
  suite_id: string;
  annotation_count: number;
  output_dir: string;
  annotator_dir: string;
  tasks_path: string;
  private_map_path: string;
  rubric_path: string;
}

export interface PromotionAnnotationLabel {
  decision: PromotionDecision;
  blocking_concerns: string[];
  repair_owners: string[];
}

export interface PromotionAnnotationRecord extends PromotionAnnotationLabel {
  schema_version: "1.0";
  annotation_id: string;
  adjudicator_id: string;
  label_source: "human";
  rationale: string;
}

interface PromotionAnnotationMapEntry {
  annotation_id: string;
  case_id: string;
  case_manifest_sha256: string;
  artifact_sha256: string;
}

interface PromotionAnnotationPrivateMap {
  schema_version: "1.0";
  suite_id: string;
  suite_manifest_sha256: string;
  entries: PromotionAnnotationMapEntry[];
}

export interface PromotionAdjudicationIssue {
  code: string;
  message: string;
  ref?: string;
}

export interface PromotionEligibilityBlocker {
  code: string;
  message: string;
}

export interface PromotionAdjudicationEligibility {
  paper_claim_eligible: boolean;
  base_bundle_count: number;
  case_count: number;
  source_family_count: number;
  operator_group_count: number;
  blockers: PromotionEligibilityBlocker[];
}

export interface PromotionAdjudicationReport {
  schema_version: "1.0";
  generated_at: string;
  suite_id: string;
  passed: boolean;
  initial_adjudicator_ids: string[];
  resolver_id: string | null;
  case_count: number;
  accepted_label_count: number;
  disagreement_count: number;
  resolved_disagreement_count: number;
  agreement: {
    decision_exact_rate: number | null;
    decision_cohens_kappa: number | null;
    blocking_concern_exact_rate: number | null;
    repair_owner_exact_rate: number | null;
    full_label_exact_rate: number | null;
  };
  validation_issues: PromotionAdjudicationIssue[];
  execution_provenance_status: PromotionBenchmarkExecutionProvenanceStatus | "unspecified";
  source_diversity_status: PromotionBenchmarkSourceDiversityStatus | "unspecified";
  mutation_isolation: {
    status: "unreviewed" | "double_verified";
    report_path: string | null;
    validation_issues: PromotionMutationAuditIssue[];
  };
  adjudication_provenance: PromotionBenchmarkAdjudicationProvenance | null;
  eligibility: PromotionAdjudicationEligibility;
  adjudicated_suite_path: string | null;
}

export interface AdjudicatePromotionBenchmarkInput {
  cwd: string;
  suitePath: string;
  privateMapPath: string;
  annotationPaths: string[];
  resolutionPath?: string;
  mutationAuditReportPath?: string;
  outDir: string;
}

export interface AdjudicatePromotionBenchmarkResult {
  report: PromotionAdjudicationReport;
  output_dir: string;
  report_path: string;
  labels_path: string | null;
  suite_path: string | null;
}

export async function exportPromotionAnnotationPack(
  input: ExportPromotionAnnotationPackInput
): Promise<ExportPromotionAnnotationPackResult> {
  const cwd = path.resolve(input.cwd);
  const suitePath = path.resolve(cwd, input.suitePath);
  const outDir = path.resolve(cwd, input.outDir);
  const loaded = await loadPromotionBenchmarkSuite(suitePath);
  if (!loaded.suite || loaded.issues.length > 0) {
    throw new Error(`Promotion suite is invalid: ${loaded.issues.map((issue) => issue.code).join(", ") || "unreadable"}`);
  }
  if (await pathExists(outDir)) throw new Error(`Promotion annotation output already exists: ${portableRef(cwd, outDir)}`);

  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(path.dirname(outDir), `.${path.basename(outDir)}.tmp-`));
  try {
    const seenAnnotationIds = new Set<string>();
    const mapEntries: PromotionAnnotationMapEntry[] = [];
    const tasks: string[] = [];
    for (const [index, benchmarkCase] of loaded.suite.cases.entries()) {
      const artifactRoot = loaded.suite.case_artifact_roots[benchmarkCase.case_id];
      const artifactHash = await hashPromotionArtifactTree(artifactRoot);
      const caseManifestPath = path.resolve(loaded.suite.suite_root, loaded.suite.manifest.cases[index]);
      const annotationId = opaqueAnnotationId(loaded.suite.manifest.suite_id, benchmarkCase.case_id, artifactHash);
      if (seenAnnotationIds.has(annotationId)) throw new Error(`Opaque annotation id collision: ${annotationId}`);
      seenAnnotationIds.add(annotationId);
      await fs.cp(artifactRoot, path.join(stagingRoot, "annotator", "artifacts", annotationId), {
        recursive: true,
        errorOnExist: true,
        force: false
      });
      tasks.push(JSON.stringify({
        schema_version: "1.0",
        annotation_id: annotationId,
        artifact_root: `artifacts/${annotationId}`,
        allowed_decisions: PROMOTION_DECISIONS,
        required_output_fields: [
          "schema_version",
          "annotation_id",
          "adjudicator_id",
          "label_source",
          "decision",
          "blocking_concerns",
          "repair_owners",
          "rationale"
        ]
      }));
      mapEntries.push({
        annotation_id: annotationId,
        case_id: benchmarkCase.case_id,
        case_manifest_sha256: await hashFile(caseManifestPath),
        artifact_sha256: artifactHash
      });
    }
    const privateMap: PromotionAnnotationPrivateMap = {
      schema_version: "1.0",
      suite_id: loaded.suite.manifest.suite_id,
      suite_manifest_sha256: await hashFile(suitePath),
      entries: mapEntries
    };
    await fs.writeFile(path.join(stagingRoot, "annotator", "annotation-tasks.jsonl"), `${tasks.join("\n")}\n`, "utf8");
    await writeJsonFile(path.join(stagingRoot, "private-annotation-map.json"), privateMap);
    await fs.writeFile(path.join(stagingRoot, "annotator", "RUBRIC.md"), annotationRubric(), "utf8");
    await fs.rename(stagingRoot, outDir);
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  return {
    suite_id: loaded.suite.manifest.suite_id,
    annotation_count: loaded.suite.cases.length,
    output_dir: portableRef(cwd, outDir),
    annotator_dir: portableRef(cwd, path.join(outDir, "annotator")),
    tasks_path: portableRef(cwd, path.join(outDir, "annotator", "annotation-tasks.jsonl")),
    private_map_path: portableRef(cwd, path.join(outDir, "private-annotation-map.json")),
    rubric_path: portableRef(cwd, path.join(outDir, "annotator", "RUBRIC.md"))
  };
}

export async function adjudicatePromotionBenchmark(
  input: AdjudicatePromotionBenchmarkInput
): Promise<AdjudicatePromotionBenchmarkResult> {
  const cwd = path.resolve(input.cwd);
  const suitePath = path.resolve(cwd, input.suitePath);
  const privateMapPath = path.resolve(cwd, input.privateMapPath);
  const annotationPaths = input.annotationPaths.map((annotationPath) => path.resolve(cwd, annotationPath));
  const resolutionPath = input.resolutionPath ? path.resolve(cwd, input.resolutionPath) : null;
  const mutationAuditReportPath = input.mutationAuditReportPath
    ? path.resolve(cwd, input.mutationAuditReportPath)
    : null;
  const outDir = path.resolve(cwd, input.outDir);
  if (await pathExists(outDir)) throw new Error(`Promotion adjudication output already exists: ${portableRef(cwd, outDir)}`);
  if (input.annotationPaths.length !== 2) throw new Error("Promotion adjudication requires exactly two independent annotation files.");

  const loaded = await loadPromotionBenchmarkSuite(suitePath);
  if (!loaded.suite || loaded.issues.length > 0) {
    throw new Error(`Promotion suite is invalid: ${loaded.issues.map((issue) => issue.code).join(", ") || "unreadable"}`);
  }
  const privateMap = parsePrivateMap(JSON.parse(await fs.readFile(privateMapPath, "utf8")) as unknown);
  const issues: PromotionAdjudicationIssue[] = [];
  if (privateMap.suite_id !== loaded.suite.manifest.suite_id) {
    issues.push({ code: "annotation_map_suite_mismatch", message: "Private annotation map belongs to a different suite." });
  }
  if (privateMap.suite_manifest_sha256 !== await hashFile(suitePath)) {
    issues.push({ code: "annotation_map_hash_mismatch", message: "Suite manifest changed after annotation export." });
  }
  await validatePrivateMap(
    privateMap,
    loaded.suite.cases,
    loaded.suite.suite_root,
    loaded.suite.manifest.cases,
    loaded.suite.case_artifact_roots,
    issues
  );

  const annotationSets = await Promise.all(annotationPaths.map(async (annotationPath) =>
    readAnnotationFile(annotationPath, privateMap, issues)));
  const adjudicatorIds = annotationSets.map((set) => set.adjudicator_id).filter(nonEmptyString);
  if (new Set(adjudicatorIds).size !== 2) {
    issues.push({ code: "initial_adjudicators_not_independent", message: "Initial annotation files must use two distinct adjudicator IDs." });
  }

  const first = annotationSets[0].records;
  const second = annotationSets[1].records;
  const disagreements = privateMap.entries.filter((entry) => {
    const left = first.get(entry.annotation_id);
    const right = second.get(entry.annotation_id);
    return Boolean(left && right && !labelsEqual(left, right));
  });
  const resolution = resolutionPath
    ? await readAnnotationFile(resolutionPath, privateMap, issues, new Set(disagreements.map((entry) => entry.annotation_id)))
    : { adjudicator_id: "", records: new Map<string, PromotionAnnotationRecord>() };
  if (resolution.adjudicator_id && new Set(adjudicatorIds).has(resolution.adjudicator_id)) {
    issues.push({ code: "resolver_not_independent", message: "Resolver ID must differ from both initial adjudicator IDs." });
  }
  for (const disagreement of disagreements) {
    if (!resolution.records.has(disagreement.annotation_id)) {
      issues.push({
        code: "unresolved_annotation_disagreement",
        message: "A third-party resolution is required for every label disagreement.",
        ref: disagreement.annotation_id
      });
    }
  }

  const accepted = new Map<string, { label: PromotionAnnotationLabel; source: string; adjudicator_ids: string[] }>();
  for (const entry of privateMap.entries) {
    const left = first.get(entry.annotation_id);
    const right = second.get(entry.annotation_id);
    if (!left || !right) continue;
    if (labelsEqual(left, right)) {
      accepted.set(entry.case_id, {
        label: labelFrom(left),
        source: "double_adjudication_consensus",
        adjudicator_ids: [left.adjudicator_id, right.adjudicator_id]
      });
      continue;
    }
    const resolved = resolution.records.get(entry.annotation_id);
    if (resolved) {
      accepted.set(entry.case_id, {
        label: labelFrom(resolved),
        source: "third_party_resolution",
        adjudicator_ids: [left.adjudicator_id, right.adjudicator_id, resolved.adjudicator_id]
      });
    }
  }

  const agreementPairs = privateMap.entries.flatMap((entry) => {
    const left = first.get(entry.annotation_id);
    const right = second.get(entry.annotation_id);
    return left && right ? [[left, right] as const] : [];
  });
  const passed = issues.length === 0 && accepted.size === loaded.suite.cases.length;
  const mutationIsolationValidation = mutationAuditReportPath
    ? await validateVerifiedPromotionMutationAuditReport({
        reportPath: mutationAuditReportPath,
        suitePath,
        suiteId: loaded.suite.manifest.suite_id,
        cases: loaded.suite.cases
      })
    : {
        verified: false,
        auditor_ids: [],
        issues: [{
          code: "mutation_isolation_report_missing",
          message: "A separately double-audited mutation-isolation report is required for paper eligibility."
        }]
      };
  const roleOverlap = mutationIsolationValidation.auditor_ids.filter((auditorId) =>
    new Set(adjudicatorIds).has(auditorId));
  const mutationIsolationIssues = [
    ...mutationIsolationValidation.issues,
    ...(roleOverlap.length > 0 ? [{
      code: "mutation_auditors_not_role_separated",
      message: "Mutation-isolation auditors must use IDs distinct from promotion-label adjudicators.",
      ref: roleOverlap.sort().join(",")
    }] : [])
  ];
  const mutationIsolationVerified = mutationIsolationValidation.verified && roleOverlap.length === 0;
  const adjudicatedCases = loaded.suite.cases.map((benchmarkCase) => ({
    ...benchmarkCase,
    gold: accepted.get(benchmarkCase.case_id)?.label || benchmarkCase.gold
  }));
  const eligibility = evaluatePromotionAdjudicationEligibility({
    evidence_class: loaded.suite.manifest.evidence_class,
    execution_provenance_status: loaded.suite.manifest.execution_provenance_status,
    source_diversity_status: loaded.suite.manifest.source_diversity_status,
    cases: adjudicatedCases,
    adjudication_complete: passed,
    mutation_isolation_verified: mutationIsolationVerified,
    confirmatory_freeze_verified:
      loaded.suite.manifest.confirmatory_freeze_provenance?.intake_tier === "paper_scale"
      && Boolean(loaded.suite.manifest.confirmatory_freeze_provenance.candidate_review)
  });
  const labelRows = passed
    ? privateMap.entries.map((entry) => {
        const adjudicated = accepted.get(entry.case_id);
        if (!adjudicated) throw new Error(`Accepted label missing for ${entry.case_id}.`);
        const left = first.get(entry.annotation_id);
        const right = second.get(entry.annotation_id);
        if (!left || !right) throw new Error(`Initial adjudication trace missing for ${entry.case_id}.`);
        return JSON.stringify({
          schema_version: "1.0",
          case_id: entry.case_id,
          ...adjudicated.label,
          adjudication_source: adjudicated.source,
          adjudicator_ids: adjudicated.adjudicator_ids,
          initial_annotations: [left, right],
          resolution: resolution.records.get(entry.annotation_id) || null
        });
      })
    : [];
  const labelsText = passed ? `${labelRows.join("\n")}\n` : null;
  const initialAnnotationSha256 = passed
    ? await Promise.all(annotationPaths.map(hashFile))
    : [];
  const privateAnnotationMapRef = "adjudication/private-annotation-map.json";
  const initialAnnotationRefs = [
    "adjudication/initial-annotation-1.jsonl",
    "adjudication/initial-annotation-2.jsonl"
  ] as [string, string];
  const resolutionRef = resolutionPath ? "adjudication/resolution.jsonl" : null;
  const mutationAuditReportRef = mutationAuditReportPath ? "adjudication/mutation-audit-report.json" : null;
  const adjudicatedLabelsRef = "adjudication/adjudicated-labels.jsonl";
  const sourceSuiteEvidence: PromotionBenchmarkSourceSuiteEvidence = {
    schema_version: "1.0",
    method: "contained_source_suite_manifests",
    suite_manifest_ref: "adjudication/source-suite/suite.json",
    suite_manifest_sha256: await hashFile(suitePath),
    case_manifests: await Promise.all(loaded.suite.manifest.cases.map(async (sourceRef, index) => ({
      case_id: loaded.suite!.cases[index].case_id,
      source_ref: sourceRef,
      evidence_ref: `adjudication/source-suite/case-manifests/${String(index + 1).padStart(6, "0")}.json`,
      sha256: await hashFile(path.resolve(loaded.suite!.suite_root, sourceRef))
    })))
  };
  const adjudicationProvenance: PromotionBenchmarkAdjudicationProvenance | null = passed && labelsText
    ? {
        schema_version: "1.0",
        method: "independent_double_adjudication",
        source_suite_snapshot_sha256: await hashPromotionBenchmarkSuiteSnapshot(suitePath),
        source_suite_evidence: sourceSuiteEvidence,
        private_annotation_map_ref: privateAnnotationMapRef,
        private_annotation_map_sha256: await hashFile(privateMapPath),
        initial_annotation_refs: initialAnnotationRefs,
        initial_annotation_sha256: [initialAnnotationSha256[0], initialAnnotationSha256[1]],
        resolution_ref: resolutionRef,
        resolution_sha256: resolutionPath ? await hashFile(resolutionPath) : null,
        mutation_audit_report_ref: mutationAuditReportRef,
        mutation_audit_report_sha256: mutationAuditReportPath ? await hashFile(mutationAuditReportPath) : null,
        adjudicated_labels_ref: adjudicatedLabelsRef,
        adjudicated_labels_sha256: createHash("sha256").update(labelsText).digest("hex"),
        case_count: loaded.suite.cases.length
      }
    : null;

  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(path.dirname(outDir), `.${path.basename(outDir)}.tmp-`));
  let suiteOutputPath: string | null = null;
  let labelsOutputPath: string | null = null;
  try {
    if (passed) {
      if (!adjudicationProvenance || !labelsText) {
        throw new Error("Adjudication provenance was not generated for a completed adjudication.");
      }
      const copiedSuiteRoot = path.join(stagingRoot, "suite");
      await fs.cp(loaded.suite.suite_root, copiedSuiteRoot, { recursive: true, errorOnExist: true, force: false });
      const adjudicationEvidenceRoot = path.join(copiedSuiteRoot, "adjudication");
      await fs.rm(adjudicationEvidenceRoot, { recursive: true, force: true });
      await fs.mkdir(adjudicationEvidenceRoot, { recursive: true });
      await fs.mkdir(
        path.join(copiedSuiteRoot, "adjudication", "source-suite", "case-manifests"),
        { recursive: true }
      );
      await fs.copyFile(
        suitePath,
        path.join(copiedSuiteRoot, sourceSuiteEvidence.suite_manifest_ref)
      );
      await Promise.all(sourceSuiteEvidence.case_manifests.map((item) =>
        fs.copyFile(
          path.resolve(loaded.suite!.suite_root, item.source_ref),
          path.join(copiedSuiteRoot, item.evidence_ref)
        )));
      await fs.copyFile(privateMapPath, path.join(copiedSuiteRoot, privateAnnotationMapRef));
      await Promise.all(annotationPaths.map((annotationPath, index) =>
        fs.copyFile(annotationPath, path.join(copiedSuiteRoot, initialAnnotationRefs[index]))));
      if (resolutionPath && resolutionRef) {
        await fs.copyFile(resolutionPath, path.join(copiedSuiteRoot, resolutionRef));
      }
      if (mutationAuditReportPath && mutationAuditReportRef) {
        await fs.copyFile(mutationAuditReportPath, path.join(copiedSuiteRoot, mutationAuditReportRef));
      }
      await fs.writeFile(path.join(copiedSuiteRoot, adjudicatedLabelsRef), labelsText, "utf8");
      for (const [index, caseRef] of loaded.suite.manifest.cases.entries()) {
        const benchmarkCase = loaded.suite.cases[index];
        const adjudicated = accepted.get(benchmarkCase.case_id);
        if (!adjudicated) throw new Error(`Accepted label missing for ${benchmarkCase.case_id}.`);
        await writeJsonFile(path.join(copiedSuiteRoot, caseRef), { ...benchmarkCase, gold: adjudicated.label });
      }
      const evidenceClass = resolvedEvidenceClass(loaded.suite.manifest.evidence_class);
      await writeJsonFile(path.join(copiedSuiteRoot, "suite.json"), {
        ...loaded.suite.manifest,
        evidence_class: evidenceClass,
        adjudication_status: "double_adjudicated",
        mutation_isolation_status: mutationIsolationVerified ? "double_verified" : "unreviewed",
        paper_claim_eligible: eligibility.paper_claim_eligible,
        adjudication_provenance: adjudicationProvenance
      });
      await fs.writeFile(path.join(stagingRoot, "adjudicated-labels.jsonl"), labelsText, "utf8");
      suiteOutputPath = portableRef(cwd, path.join(outDir, "suite", "suite.json"));
      labelsOutputPath = portableRef(cwd, path.join(outDir, "adjudicated-labels.jsonl"));
    }

    const report: PromotionAdjudicationReport = {
      schema_version: "1.0",
      generated_at: new Date().toISOString(),
      suite_id: loaded.suite.manifest.suite_id,
      passed,
      initial_adjudicator_ids: [...new Set(adjudicatorIds)].sort(),
      resolver_id: resolution.adjudicator_id || null,
      case_count: loaded.suite.cases.length,
      accepted_label_count: accepted.size,
      disagreement_count: disagreements.length,
      resolved_disagreement_count: disagreements.filter((entry) => resolution.records.has(entry.annotation_id)).length,
      agreement: agreementMetrics(agreementPairs),
      validation_issues: issues,
      execution_provenance_status: loaded.suite.manifest.execution_provenance_status || "unspecified",
      source_diversity_status: loaded.suite.manifest.source_diversity_status || "unspecified",
      mutation_isolation: {
        status: mutationIsolationVerified ? "double_verified" : "unreviewed",
        report_path: mutationAuditReportPath
          ? portableRef(cwd, mutationAuditReportPath)
          : null,
        validation_issues: mutationIsolationIssues
      },
      adjudication_provenance: adjudicationProvenance,
      eligibility,
      adjudicated_suite_path: suiteOutputPath
    };
    await writeJsonFile(path.join(stagingRoot, "adjudication-report.json"), report);
    await writeAdjudicationReviewArtifacts(stagingRoot, report);
    await fs.rename(stagingRoot, outDir);
    return {
      report,
      output_dir: portableRef(cwd, outDir),
      report_path: portableRef(cwd, path.join(outDir, "adjudication-report.json")),
      labels_path: labelsOutputPath,
      suite_path: suiteOutputPath
    };
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

async function writeAdjudicationReviewArtifacts(
  outputRoot: string,
  report: PromotionAdjudicationReport
): Promise<void> {
  const rows = [
    ...report.validation_issues.map((issue) => ({ code: issue.code, message: issue.message, ref: issue.ref })),
    ...report.mutation_isolation.validation_issues.map((issue) => ({ code: issue.code, message: issue.message, ref: issue.ref })),
    ...report.eligibility.blockers.map((blocker) => ({ code: blocker.code, message: blocker.message, ref: undefined }))
  ];
  const seen = new Set<string>();
  const diagnostics = rows.flatMap((row) => {
    const key = `${row.code}\0${row.ref || ""}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const targetNode = adjudicationRepairTarget(row.code);
    return [{
      id: `promotion_adjudication:${row.code}${row.ref ? `:${row.ref}` : ""}`,
      severity: "blocking",
      target_node: targetNode,
      source_node: "review",
      summary: row.message,
      recheck_condition: `Re-run promotion adjudication and require ${row.code} to be absent.`,
      ...(row.ref ? { ref: row.ref } : {})
    }];
  });
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
    outcome: report.eligibility.paper_claim_eligible ? "accept" : "revise",
    adjudication_passed: report.passed,
    mutation_isolation_status: report.mutation_isolation.status,
    execution_provenance_status: report.execution_provenance_status,
    source_diversity_status: report.source_diversity_status,
    paper_claim_eligible: report.eligibility.paper_claim_eligible,
    diagnostic_count: diagnostics.length
  });
}

function adjudicationRepairTarget(code: string): "run_experiments" | "design_experiments" | "review" {
  if (code === "external_real_run_evidence_required" || code === "execution_provenance_not_artifact_verified") {
    return "run_experiments";
  }
  if (code === "held_out_test_split_required"
      || code === "base_bundle_minimum_not_met"
      || code === "held_out_case_minimum_not_met"
      || code === "base_source_provenance_incomplete"
      || code === "base_source_hash_reuse"
      || code === "source_diversity_not_declared_stratified"
      || code === "source_family_provenance_incomplete"
      || code === "operator_group_provenance_incomplete"
      || code === "source_family_minimum_not_met"
      || code === "operator_group_minimum_not_met"
      || code === "source_family_share_exceeded"
      || code === "operator_group_share_exceeded"
      || code === "paired_fault_family_coverage_incomplete"
      || code === "clean_control_outcome_coverage_incomplete"
      || code === "mutation_isolation_not_double_verified"
      || code === "confirmatory_freeze_not_verified") {
    return "design_experiments";
  }
  return "review";
}

export function evaluatePromotionAdjudicationEligibility(input: {
  evidence_class?: PromotionBenchmarkEvidenceClass;
  execution_provenance_status?: PromotionBenchmarkExecutionProvenanceStatus;
  source_diversity_status?: PromotionBenchmarkSourceDiversityStatus;
  cases: PromotionBenchmarkCaseManifest[];
  adjudication_complete: boolean;
  mutation_isolation_verified: boolean;
  confirmatory_freeze_verified?: boolean;
}): PromotionAdjudicationEligibility {
  const blockers: PromotionEligibilityBlocker[] = [];
  const baseIds = [...new Set(input.cases.map((benchmarkCase) => benchmarkCase.base_bundle_id))];
  const sourceDiversity = inspectPromotionSourceDiversity(input.cases);
  if (!input.adjudication_complete) {
    blockers.push({ code: "double_adjudication_incomplete", message: "All cases require two independent labels and resolved disagreements." });
  }
  if (!input.mutation_isolation_verified) {
    blockers.push({
      code: "mutation_isolation_double_audit_incomplete",
      message: "Every mutated case requires two independent isolation audits with no confounded mutation."
    });
  }
  if (!input.confirmatory_freeze_verified) {
    blockers.push({
      code: "confirmatory_freeze_not_verified",
      message: "Paper eligibility requires a hash-bound paper-scale confirmatory freeze and candidate-review receipt."
    });
  }
  if (input.evidence_class !== "external_real_run") {
    blockers.push({ code: "external_real_run_evidence_required", message: "Paper-eligible confirmatory suites require external real-run artifacts." });
  }
  if (input.execution_provenance_status !== "artifact_verified") {
    blockers.push({
      code: "execution_provenance_not_artifact_verified",
      message: "Every confirmatory source requires hash-bound execution artifacts and a passing intake provenance audit."
    });
  }
  if (input.source_diversity_status !== "declared_stratified") {
    blockers.push({
      code: "source_diversity_not_declared_stratified",
      message: "Paper-eligible confirmatory suites require declared source-family and operator-group stratification."
    });
  } else {
    blockers.push(...sourceDiversity.issues);
  }
  if (input.cases.some((benchmarkCase) => benchmarkCase.split !== "test")) {
    blockers.push({ code: "held_out_test_split_required", message: "Every confirmatory case must belong to the held-out test split." });
  }
  if (baseIds.length < MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES) {
    blockers.push({
      code: "base_bundle_minimum_not_met",
      message: `Expected at least ${MINIMUM_PROMOTION_PAPER_ELIGIBLE_BASE_BUNDLES} base bundles; observed ${baseIds.length}.`
    });
  }
  if (input.cases.length < MINIMUM_PROMOTION_PAPER_ELIGIBLE_CASES) {
    blockers.push({
      code: "held_out_case_minimum_not_met",
      message: `Expected at least ${MINIMUM_PROMOTION_PAPER_ELIGIBLE_CASES} cases; observed ${input.cases.length}.`
    });
  }
  const cleanDecisions = new Set(input.cases
    .filter((benchmarkCase) => !benchmarkCase.mutation_family)
    .map((benchmarkCase) => benchmarkCase.gold.decision));
  if (!cleanDecisions.has("promote") || !["downgrade", "block"].some((decision) => cleanDecisions.has(decision as PromotionDecision))) {
    blockers.push({
      code: "clean_control_outcome_coverage_incomplete",
      message: "Clean controls must include both promotable and non-promotable outcomes."
    });
  }

  const baseSourceHashes = new Map<string, Set<string>>();
  for (const benchmarkCase of input.cases) {
    const hashes = baseSourceHashes.get(benchmarkCase.base_bundle_id) || new Set<string>();
    if (benchmarkCase.source_sha256) hashes.add(benchmarkCase.source_sha256);
    baseSourceHashes.set(benchmarkCase.base_bundle_id, hashes);
  }
  if ([...baseSourceHashes.values()].some((hashes) => hashes.size !== 1)) {
    blockers.push({ code: "base_source_provenance_incomplete", message: "Each base bundle must have exactly one source hash across its variants." });
  }
  const ownerByHash = new Map<string, string>();
  let reusedSourceHash = false;
  for (const [baseId, hashes] of baseSourceHashes) {
    for (const hash of hashes) {
      const owner = ownerByHash.get(hash);
      if (owner && owner !== baseId) reusedSourceHash = true;
      ownerByHash.set(hash, baseId);
    }
  }
  if (reusedSourceHash) {
    blockers.push({ code: "base_source_hash_reuse", message: "Different base bundle IDs must not share an identical source hash." });
  }

  let incompleteBaseCoverage = 0;
  for (const baseId of baseIds) {
    const cases = input.cases.filter((benchmarkCase) => benchmarkCase.base_bundle_id === baseId);
    const families = new Set(cases.map((benchmarkCase) => benchmarkCase.mutation_family).filter(nonEmptyString));
    const hasClean = cases.some((benchmarkCase) => !benchmarkCase.mutation_family);
    if (!hasClean || REQUIRED_CONFIRMATORY_MUTATION_FAMILIES.some((family) => !families.has(family))) {
      incompleteBaseCoverage += 1;
    }
  }
  if (incompleteBaseCoverage > 0) {
    blockers.push({
      code: "paired_fault_family_coverage_incomplete",
      message: `${incompleteBaseCoverage} base bundle(s) lack a clean control or one of the nine required fault families.`
    });
  }

  return {
    paper_claim_eligible: blockers.length === 0,
    base_bundle_count: baseIds.length,
    case_count: input.cases.length,
    source_family_count: sourceDiversity.source_family_count,
    operator_group_count: sourceDiversity.operator_group_count,
    blockers
  };
}

async function validatePrivateMap(
  privateMap: PromotionAnnotationPrivateMap,
  cases: PromotionBenchmarkCaseManifest[],
  suiteRoot: string,
  caseRefs: string[],
  caseArtifactRoots: Record<string, string>,
  issues: PromotionAdjudicationIssue[]
): Promise<void> {
  const caseById = new Map(cases.map((benchmarkCase) => [benchmarkCase.case_id, benchmarkCase]));
  const caseRefById = new Map(cases.map((benchmarkCase, index) => [benchmarkCase.case_id, caseRefs[index]]));
  const seenAnnotations = new Set<string>();
  const seenCases = new Set<string>();
  for (const entry of privateMap.entries) {
    if (seenAnnotations.has(entry.annotation_id)) {
      issues.push({ code: "annotation_map_duplicate_id", message: "Private map contains a duplicate annotation ID.", ref: entry.annotation_id });
    }
    if (seenCases.has(entry.case_id)) {
      issues.push({ code: "annotation_map_duplicate_case", message: "Private map contains a duplicate case ID.", ref: entry.case_id });
    }
    seenAnnotations.add(entry.annotation_id);
    seenCases.add(entry.case_id);
    const benchmarkCase = caseById.get(entry.case_id);
    if (!benchmarkCase) {
      issues.push({ code: "annotation_map_unknown_case", message: "Private map references a case outside the suite.", ref: entry.case_id });
    } else {
      const caseRef = caseRefById.get(entry.case_id);
      if (!caseRef || await hashFile(path.resolve(suiteRoot, caseRef)) !== entry.case_manifest_sha256) {
        issues.push({ code: "annotation_map_case_manifest_hash_mismatch", message: "Case manifest changed after annotation export.", ref: entry.case_id });
      }
      if (await hashPromotionArtifactTree(caseArtifactRoots[entry.case_id]) !== entry.artifact_sha256) {
        issues.push({ code: "annotation_map_artifact_hash_mismatch", message: "Artifact content changed after annotation export.", ref: entry.case_id });
      }
    }
  }
  if (seenCases.size !== cases.length) {
    issues.push({ code: "annotation_map_case_coverage_incomplete", message: "Private annotation map must cover every suite case exactly once." });
  }
}

async function readAnnotationFile(
  filePath: string,
  privateMap: PromotionAnnotationPrivateMap,
  issues: PromotionAdjudicationIssue[],
  expectedIds = new Set(privateMap.entries.map((entry) => entry.annotation_id))
): Promise<{ adjudicator_id: string; records: Map<string, PromotionAnnotationRecord> }> {
  const records = new Map<string, PromotionAnnotationRecord>();
  const adjudicatorIds = new Set<string>();
  const allowedIds = new Set(privateMap.entries.map((entry) => entry.annotation_id));
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    issues.push({ code: "annotation_file_unreadable", message: error instanceof Error ? error.message : String(error), ref: portableRef(path.dirname(filePath), filePath) });
    return { adjudicator_id: "", records };
  }
  for (const [index, line] of raw.split(/\r?\n/gu).entries()) {
    if (!line.trim()) continue;
    let parsed: PromotionAnnotationRecord;
    try {
      parsed = parseAnnotationRecord(JSON.parse(line) as unknown, `${path.basename(filePath)}:${index + 1}`);
    } catch (error) {
      issues.push({ code: "annotation_record_invalid", message: error instanceof Error ? error.message : String(error), ref: `${path.basename(filePath)}:${index + 1}` });
      continue;
    }
    if (!allowedIds.has(parsed.annotation_id)) {
      issues.push({ code: "annotation_unknown_id", message: "Annotation record references an unknown opaque ID.", ref: parsed.annotation_id });
      continue;
    }
    if (!expectedIds.has(parsed.annotation_id)) {
      issues.push({ code: "annotation_unexpected_resolution", message: "Resolution file includes a case without an initial disagreement.", ref: parsed.annotation_id });
      continue;
    }
    if (records.has(parsed.annotation_id)) {
      issues.push({ code: "annotation_duplicate_id", message: "Annotation file contains a duplicate opaque ID.", ref: parsed.annotation_id });
      continue;
    }
    records.set(parsed.annotation_id, parsed);
    adjudicatorIds.add(parsed.adjudicator_id);
  }
  if (adjudicatorIds.size !== 1) {
    issues.push({ code: "annotation_file_adjudicator_inconsistent", message: "Each annotation file must contain exactly one adjudicator ID.", ref: path.basename(filePath) });
  }
  for (const expectedId of expectedIds) {
    if (!records.has(expectedId)) {
      issues.push({ code: "annotation_case_coverage_incomplete", message: "Annotation file is missing a required opaque ID.", ref: expectedId });
    }
  }
  return { adjudicator_id: [...adjudicatorIds][0] || "", records };
}

function parsePrivateMap(value: unknown): PromotionAnnotationPrivateMap {
  if (!isRecord(value) || value.schema_version !== "1.0" || !nonEmptyString(value.suite_id)
      || !isSha256(value.suite_manifest_sha256) || !Array.isArray(value.entries) || value.entries.length === 0) {
    throw new Error("Private annotation map is invalid.");
  }
  const entries = value.entries.map((entry, index) => {
    if (!isRecord(entry) || !nonEmptyString(entry.annotation_id) || !nonEmptyString(entry.case_id)
        || !isSha256(entry.case_manifest_sha256) || !isSha256(entry.artifact_sha256)) {
      throw new Error(`Private annotation map entry ${index + 1} is invalid.`);
    }
    return {
      annotation_id: entry.annotation_id,
      case_id: entry.case_id,
      case_manifest_sha256: entry.case_manifest_sha256,
      artifact_sha256: entry.artifact_sha256
    };
  });
  return {
    schema_version: "1.0",
    suite_id: value.suite_id,
    suite_manifest_sha256: value.suite_manifest_sha256,
    entries
  };
}

function parseAnnotationRecord(value: unknown, ref: string): PromotionAnnotationRecord {
  if (!isRecord(value) || value.schema_version !== "1.0" || !nonEmptyString(value.annotation_id)
      || !nonEmptyString(value.adjudicator_id) || value.label_source !== "human"
      || !isPromotionDecision(value.decision) || !uniqueStringArray(value.blocking_concerns)
      || !uniqueStringArray(value.repair_owners) || !nonEmptyString(value.rationale)) {
    throw new Error(`Annotation record ${ref} has an invalid schema.`);
  }
  if (value.decision === "promote" && (value.blocking_concerns.length > 0 || value.repair_owners.length > 0)) {
    throw new Error(`Annotation record ${ref} cannot promote while retaining blocking concerns or repair owners.`);
  }
  const invalidRepairOwners = value.repair_owners.filter((owner) =>
    !(GRAPH_NODE_ORDER as readonly string[]).includes(owner));
  if (invalidRepairOwners.length > 0) {
    throw new Error(`Annotation record ${ref} contains unknown repair-owner nodes: ${invalidRepairOwners.join(", ")}.`);
  }
  return {
    schema_version: "1.0",
    annotation_id: value.annotation_id,
    adjudicator_id: value.adjudicator_id,
    label_source: "human",
    decision: value.decision,
    blocking_concerns: [...value.blocking_concerns].sort(),
    repair_owners: [...value.repair_owners].sort(),
    rationale: value.rationale
  };
}

function agreementMetrics(pairs: ReadonlyArray<readonly [PromotionAnnotationRecord, PromotionAnnotationRecord]>): PromotionAdjudicationReport["agreement"] {
  if (pairs.length === 0) {
    return {
      decision_exact_rate: null,
      decision_cohens_kappa: null,
      blocking_concern_exact_rate: null,
      repair_owner_exact_rate: null,
      full_label_exact_rate: null
    };
  }
  const ratio = (predicate: (pair: readonly [PromotionAnnotationRecord, PromotionAnnotationRecord]) => boolean) =>
    pairs.filter(predicate).length / pairs.length;
  const observed = ratio(([left, right]) => left.decision === right.decision);
  const expected = PROMOTION_DECISIONS.reduce((sum, decision) => {
    const leftRate = pairs.filter(([left]) => left.decision === decision).length / pairs.length;
    const rightRate = pairs.filter(([, right]) => right.decision === decision).length / pairs.length;
    return sum + leftRate * rightRate;
  }, 0);
  return {
    decision_exact_rate: observed,
    decision_cohens_kappa: expected === 1 ? null : (observed - expected) / (1 - expected),
    blocking_concern_exact_rate: ratio(([left, right]) => arraysEqual(left.blocking_concerns, right.blocking_concerns)),
    repair_owner_exact_rate: ratio(([left, right]) => arraysEqual(left.repair_owners, right.repair_owners)),
    full_label_exact_rate: ratio(([left, right]) => labelsEqual(left, right))
  };
}

function opaqueAnnotationId(suiteId: string, caseId: string, artifactSha256: string): string {
  const digest = createHash("sha256")
    .update(suiteId)
    .update("\0")
    .update(caseId)
    .update("\0")
    .update(artifactSha256)
    .digest("hex")
    .slice(0, 20);
  return `annotation-${digest}`;
}

function annotationRubric(): string {
  return [
    "# Promotion Annotation Rubric",
    "",
    "Inspect only the supplied opaque artifact directory. Do not use the private map, source recipe, mutation manifest, model predictions, or another adjudicator's labels.",
    "",
    "- `promote`: the artifacts support the declared readiness target without a blocking defect.",
    "- `needs_review`: the evidence may be sufficient but requires an explicit adjudication step.",
    "- `downgrade`: preserve the artifact at a lower claim or manuscript ceiling.",
    "- `block`: a blocking defect must be repaired before promotion.",
    "",
    `Valid repair-owner nodes: ${GRAPH_NODE_ORDER.map((node) => `\`${node}\``).join(", ")}.`,
    "",
    "Return one JSON Lines record per task. Use a stable pseudonymous adjudicator ID, set `label_source` to `human`, list canonical blocking concern codes and repair-owner nodes, and provide a concise artifact-grounded rationale.",
    ""
  ].join("\n");
}

function resolvedEvidenceClass(value: PromotionBenchmarkEvidenceClass | undefined): PromotionBenchmarkEvidenceClass {
  if (value === "external_real_run" || value === "synthetic_development") return value;
  return "human_adjudicated_test";
}

function labelFrom(value: PromotionAnnotationRecord): PromotionAnnotationLabel {
  return {
    decision: value.decision,
    blocking_concerns: value.blocking_concerns,
    repair_owners: value.repair_owners
  };
}

function labelsEqual(left: PromotionAnnotationLabel, right: PromotionAnnotationLabel): boolean {
  return left.decision === right.decision
    && arraysEqual(left.blocking_concerns, right.blocking_concerns)
    && arraysEqual(left.repair_owners, right.repair_owners);
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isPromotionDecision(value: unknown): value is PromotionDecision {
  return typeof value === "string" && (PROMOTION_DECISIONS as readonly string[]).includes(value);
}

function uniqueStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString) && new Set(value).size === value.length;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
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

async function hashFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

function portableRef(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath).replace(/\\/gu, "/");
  return relative && !relative.startsWith("..") ? relative : path.basename(absolutePath);
}
