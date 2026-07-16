import path from "node:path";
import { promises as fs } from "node:fs";

import {
  runPaperReadinessAudit,
  type PaperReadinessAuditBlocker,
  type PaperReadinessAuditSummary
} from "../audit/paperReadinessAudit.js";
import {
  loadPromotionBenchmarkSuite,
  type PromotionBenchmarkCaseManifest,
  type PromotionBenchmarkPrediction,
  type PromotionDecision
} from "./promotionBenchmark.js";

export const PROMOTION_BENCHMARK_SYSTEMS = [
  "always-promote",
  "presence-checklist",
  "advisory-artifact-audit",
  "artifact-audit"
] as const;

export type PromotionBenchmarkSystemName = typeof PROMOTION_BENCHMARK_SYSTEMS[number];

export interface RunPromotionBenchmarkSystemsInput {
  cwd: string;
  suitePath: string;
  outDir?: string;
  systems?: PromotionBenchmarkSystemName[];
  trialId?: string;
}

export interface RunPromotionBenchmarkSystemsResult {
  suite_id: string;
  systems: PromotionBenchmarkSystemName[];
  prediction_count: number;
  predictions_path: string;
  audit_root?: string;
}

const PRESENCE_CHECKLIST = [
  "result_table.json",
  "run_record.json",
  "review/decision.json",
  "paper/paper_readiness.json"
] as const;

const DOWNGRADE_ELIGIBLE_BLOCKERS = new Set([
  "unsupported_claims_present"
]);

export async function runPromotionBenchmarkSystems(
  input: RunPromotionBenchmarkSystemsInput
): Promise<RunPromotionBenchmarkSystemsResult> {
  const cwd = path.resolve(input.cwd);
  const suitePath = path.resolve(cwd, input.suitePath);
  const loaded = await loadPromotionBenchmarkSuite(suitePath);
  if (!loaded.suite || loaded.issues.length > 0) {
    throw new Error(`Promotion benchmark suite validation failed: ${loaded.issues.map((issue) => issue.code).join(", ")}`);
  }
  const systems = uniqueSystems(input.systems?.length ? input.systems : [...PROMOTION_BENCHMARK_SYSTEMS]);
  const outDir = path.resolve(cwd, input.outDir || path.join("outputs", "governance-benchmark", "promotion-predictions"));
  const trialId = input.trialId || "deterministic-trial";
  await fs.mkdir(outDir, { recursive: true });
  const predictions: PromotionBenchmarkPrediction[] = [];

  for (const benchmarkCase of loaded.suite.cases) {
    const artifactRoot = loaded.suite.case_artifact_roots[benchmarkCase.case_id];
    let auditPrediction: PromotionBenchmarkPrediction | undefined;
    for (const system of systems) {
      if (system === "always-promote") {
        predictions.push(alwaysPromotePrediction(benchmarkCase, trialId));
      } else if (system === "presence-checklist") {
        predictions.push(await presenceChecklistPrediction(benchmarkCase, artifactRoot, trialId));
      } else {
        auditPrediction ||= await artifactAuditPrediction({
          cwd,
          benchmarkCase,
          artifactRoot,
          auditRoot: path.join(outDir, "audits"),
          trialId
        });
        predictions.push(system === "artifact-audit"
          ? auditPrediction
          : { ...auditPrediction, system_id: "advisory-artifact-audit", decision: "promote" });
      }
    }
  }

  const predictionsPath = path.join(outDir, "predictions.jsonl");
  await fs.writeFile(predictionsPath, `${predictions.map((prediction) => JSON.stringify(prediction)).join("\n")}\n`, "utf8");
  return {
    suite_id: loaded.suite.manifest.suite_id,
    systems,
    prediction_count: predictions.length,
    predictions_path: portableRef(cwd, predictionsPath),
    ...(systems.some((system) => system.endsWith("artifact-audit"))
      ? { audit_root: portableRef(cwd, path.join(outDir, "audits")) }
      : {})
  };
}

function alwaysPromotePrediction(
  benchmarkCase: PromotionBenchmarkCaseManifest,
  trialId: string
): PromotionBenchmarkPrediction {
  return {
    case_id: benchmarkCase.case_id,
    system_id: "always-promote",
    trial_id: trialId,
    decision: "promote",
    concerns: [],
    repair_owners: [],
    latency_ms: 0,
    cost_usd: 0
  };
}

async function presenceChecklistPrediction(
  benchmarkCase: PromotionBenchmarkCaseManifest,
  artifactRoot: string,
  trialId: string
): Promise<PromotionBenchmarkPrediction> {
  const startedAt = Date.now();
  const missing: string[] = [];
  for (const relativePath of PRESENCE_CHECKLIST) {
    if (!(await fileExists(path.join(artifactRoot, relativePath)))) missing.push(relativePath);
  }
  return {
    case_id: benchmarkCase.case_id,
    system_id: "presence-checklist",
    trial_id: trialId,
    decision: missing.length > 0 ? "block" : "promote",
    concerns: missing.length > 0
      ? [{ code: "required_artifact_missing", severity: "blocking", evidence_refs: missing }]
      : [],
    repair_owners: missing.length > 0 ? ["review"] : [],
    latency_ms: Date.now() - startedAt,
    cost_usd: 0
  };
}

async function artifactAuditPrediction(input: {
  cwd: string;
  benchmarkCase: PromotionBenchmarkCaseManifest;
  artifactRoot: string;
  auditRoot: string;
  trialId: string;
}): Promise<PromotionBenchmarkPrediction> {
  const startedAt = Date.now();
  const summary = await runPaperReadinessAudit({
    cwd: input.cwd,
    runRoot: input.artifactRoot,
    outDir: path.join(input.auditRoot, input.benchmarkCase.case_id)
  });
  const actionableBlockers = summary.top_blockers.filter((blocker) => blocker.code !== "false_paper_ready_blocked");
  const blockingCodes = actionableBlockers
    .filter((blocker) => blocker.severity === "blocker")
    .map((blocker) => blocker.code);
  return {
    case_id: input.benchmarkCase.case_id,
    system_id: "artifact-audit",
    trial_id: input.trialId,
    decision: decisionFromAudit(summary, blockingCodes),
    concerns: actionableBlockers.map((blocker) => ({
      code: blocker.code,
      severity: blocker.severity === "blocker" ? "blocking" : "warning",
      evidence_refs: evidenceRefsForBlocker(blocker)
    })),
    repair_owners: repairOwnersFromAudit(summary),
    latency_ms: Date.now() - startedAt,
    cost_usd: 0
  };
}

function decisionFromAudit(summary: PaperReadinessAuditSummary, blockingCodes: string[]): PromotionDecision {
  if (summary.verdict === "conditionally-ready") return "promote";
  if (summary.verdict === "needs-review") return "needs_review";
  if (blockingCodes.length > 0 && blockingCodes.every((code) => DOWNGRADE_ELIGIBLE_BLOCKERS.has(code))) {
    return "downgrade";
  }
  return "block";
}

function repairOwnersFromAudit(summary: PaperReadinessAuditSummary): string[] {
  const owners = new Set<string>();
  for (const finding of summary.research_scale_findings) {
    if (finding.target_node) owners.add(finding.target_node);
  }
  for (const blocker of summary.top_blockers) {
    const owner = repairOwnerForBlocker(blocker.code);
    if (owner) owners.add(owner);
  }
  return [...owners].sort();
}

function repairOwnerForBlocker(code: string): string | undefined {
  if (code === "baseline_or_comparator_missing" || code === "result_table_missing" || code === "result_table_incomplete") {
    return "design_experiments";
  }
  if (code === "fallback_only_evidence" || code === "run_execution_incomplete" || code === "run_execution_failed" || code === "hidden_failed_run") {
    return "run_experiments";
  }
  if (code === "repeated_run_provenance_missing" || code === "budget_contract_mismatch") return "run_experiments";
  if (code === "stale_persisted_state") return "review";
  if (code === "unsupported_claims_present") return "analyze_results";
  if (code === "unsupported_sota_ranking") return "analyze_results";
  if (code === "citation_support_missing") return "analyze_papers";
  if (code === "figure_result_caption_mismatch") return "figure_audit";
  if (code === "write_paper_failed") return "write_paper";
  if (code === "artifact_contract_incomplete") return "review";
  return undefined;
}

function evidenceRefsForBlocker(blocker: PaperReadinessAuditBlocker): string[] {
  if (blocker.code === "baseline_or_comparator_missing" || blocker.code.startsWith("result_table_")) {
    return ["result_table.json"];
  }
  if (blocker.code === "fallback_only_evidence") return ["evidence_store.jsonl"];
  if (blocker.code === "unsupported_claims_present") return ["paper/claim_evidence_table.json"];
  if (blocker.code === "citation_support_missing") return ["paper/evidence_links.json"];
  if (blocker.code === "figure_result_caption_mismatch") return ["figure_audit/figure_audit_summary.json"];
  if (blocker.code.includes("run") || blocker.code === "write_paper_failed") return ["run_record.json"];
  if (blocker.code === "artifact_contract_incomplete") return ["artifact_contract"];
  if (blocker.code === "repeated_run_provenance_missing") return ["run_config.json", "experiment_evidence.json"];
  if (blocker.code === "budget_contract_mismatch") return ["run_config.json", "run_record.json"];
  if (blocker.code === "stale_persisted_state") return ["checkpoint/state.json", "paper/paper_readiness.json"];
  return [blocker.source];
}

function uniqueSystems(systems: PromotionBenchmarkSystemName[]): PromotionBenchmarkSystemName[] {
  const unique = [...new Set(systems)];
  for (const system of unique) {
    if (!(PROMOTION_BENCHMARK_SYSTEMS as readonly string[]).includes(system)) {
      throw new Error(`Unsupported promotion benchmark system: ${system}`);
    }
  }
  return unique;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function portableRef(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath).replace(/\\/gu, "/");
  return relative && !relative.startsWith("../") ? relative : "<external-output>";
}
