import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import {
  runPaperReadinessAudit,
  type PaperReadinessAuditBlocker,
  type PaperReadinessAuditSummary
} from "../audit/paperReadinessAudit.js";
import {
  hashPromotionBenchmarkSuiteSnapshot,
  loadPromotionBenchmarkPredictions,
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

export const PROMOTION_BENCHMARK_SYSTEM_PROTOCOL_REVISION =
  "promotion-system-protocol-v2";

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
  manifest_path: string;
  audit_root?: string;
}

export type PromotionBenchmarkSystemProtocol =
  | "ungated"
  | "artifact_presence_checklist"
  | "full_artifact_policy"
  | "gate_ablation";

export interface PromotionBenchmarkSystemRunManifest {
  schema_version: "1.0" | "1.1";
  protocol_revision: typeof PROMOTION_BENCHMARK_SYSTEM_PROTOCOL_REVISION | null;
  status: "completed";
  evidence_class: "deterministic_artifact_evaluation";
  suite_id: string;
  suite_path: string;
  suite_sha256: string;
  suite_snapshot_sha256: string;
  trial_id: string;
  generated_at: string;
  case_count: number;
  prediction_count: number;
  systems: Array<{
    system_id: PromotionBenchmarkSystemName;
    protocol: PromotionBenchmarkSystemProtocol;
    ablated_components: string[];
  }>;
  artifacts: {
    predictions_path: string;
    predictions_sha256: string;
  };
}

export interface VerifyPromotionBenchmarkSystemRunInput {
  cwd: string;
  manifestPath: string;
  suitePath: string;
  predictionsPath: string;
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
  const predictionsText = predictions.map((prediction) => JSON.stringify(prediction)).join("\n") + "\n";
  await fs.writeFile(predictionsPath, predictionsText, "utf8");
  const manifestPath = path.join(outDir, "system-run-manifest.json");
  const manifest: PromotionBenchmarkSystemRunManifest = {
    schema_version: "1.1",
    protocol_revision: PROMOTION_BENCHMARK_SYSTEM_PROTOCOL_REVISION,
    status: "completed",
    evidence_class: "deterministic_artifact_evaluation",
    suite_id: loaded.suite.manifest.suite_id,
    suite_path: portableRef(cwd, suitePath),
    suite_sha256: await sha256File(suitePath),
    suite_snapshot_sha256: await hashPromotionBenchmarkSuiteSnapshot(suitePath),
    trial_id: trialId,
    generated_at: new Date().toISOString(),
    case_count: loaded.suite.cases.length,
    prediction_count: predictions.length,
    systems: systems.map(systemDefinition),
    artifacts: {
      predictions_path: portableRef(cwd, predictionsPath),
      predictions_sha256: sha256(predictionsText)
    }
  };
  await writeJsonFile(manifestPath, manifest);
  return {
    suite_id: loaded.suite.manifest.suite_id,
    systems,
    prediction_count: predictions.length,
    predictions_path: portableRef(cwd, predictionsPath),
    manifest_path: portableRef(cwd, manifestPath),
    ...(systems.some((system) => system.endsWith("artifact-audit"))
      ? { audit_root: portableRef(cwd, path.join(outDir, "audits")) }
      : {})
  };
}

export async function verifyPromotionBenchmarkSystemRun(
  input: VerifyPromotionBenchmarkSystemRunInput
): Promise<PromotionBenchmarkSystemRunManifest> {
  const cwd = path.resolve(input.cwd);
  const manifestPath = await resolveExistingInside(cwd, path.resolve(cwd, input.manifestPath), "System run manifest");
  const suitePath = await resolveExistingInside(cwd, path.resolve(cwd, input.suitePath), "System run suite");
  const predictionsPath = await resolveExistingInside(
    cwd,
    path.resolve(cwd, input.predictionsPath),
    "System run predictions"
  );
  const manifest = parseSystemRunManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")));
  const manifestSuitePath = await resolveExistingInside(
    cwd,
    path.resolve(cwd, manifest.suite_path),
    "Manifest suite"
  );
  const manifestPredictionsPath = await resolveExistingInside(
    cwd,
    path.resolve(cwd, manifest.artifacts.predictions_path),
    "Manifest predictions"
  );
  if (manifestSuitePath !== suitePath || manifestPredictionsPath !== predictionsPath) {
    throw new Error("System run manifest artifact paths do not match the selected inputs.");
  }
  if (await sha256File(suitePath) !== manifest.suite_sha256
      || await hashPromotionBenchmarkSuiteSnapshot(suitePath) !== manifest.suite_snapshot_sha256
      || await sha256File(predictionsPath) !== manifest.artifacts.predictions_sha256) {
    throw new Error("System run manifest artifact SHA-256 mismatch.");
  }
  const loaded = await loadPromotionBenchmarkSuite(suitePath);
  const predictionLoad = await loadPromotionBenchmarkPredictions(predictionsPath);
  if (!loaded.suite || loaded.issues.length > 0 || predictionLoad.issues.length > 0) {
    throw new Error("System run manifest references invalid suite or prediction artifacts.");
  }
  if (loaded.suite.manifest.suite_id !== manifest.suite_id
      || loaded.suite.cases.length !== manifest.case_count
      || predictionLoad.predictions.length !== manifest.prediction_count) {
    throw new Error("System run manifest counts or suite identity do not match current artifacts.");
  }
  const expectedSystemIds = new Set(manifest.systems.map((system) => system.system_id));
  const actualSystemIds = new Set(predictionLoad.predictions.map((prediction) => prediction.system_id));
  if (expectedSystemIds.size !== actualSystemIds.size
      || [...expectedSystemIds].some((systemId) => !actualSystemIds.has(systemId))) {
    throw new Error("System run manifest system coverage does not match predictions.");
  }
  for (const system of manifest.systems) {
    const definition = systemDefinition(system.system_id);
    if (system.protocol !== definition.protocol
        || JSON.stringify(system.ablated_components) !== JSON.stringify(definition.ablated_components)) {
      throw new Error("System run protocol declaration does not match the built-in implementation.");
    }
    const rows = predictionLoad.predictions.filter((prediction) => prediction.system_id === system.system_id);
    if (rows.length !== loaded.suite.cases.length
        || rows.some((prediction) => prediction.trial_id !== manifest.trial_id)
        || new Set(rows.map((prediction) => prediction.case_id)).size !== loaded.suite.cases.length) {
      throw new Error("System run predictions do not have one complete declared trial per system.");
    }
  }
  return manifest;
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
  const unparseable: string[] = [];
  for (const relativePath of PRESENCE_CHECKLIST) {
    const artifactPath = path.join(artifactRoot, relativePath);
    let bytes: Buffer;
    try {
      const stat = await fs.lstat(artifactPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        missing.push(relativePath);
        continue;
      }
      bytes = await fs.readFile(artifactPath);
    } catch {
      missing.push(relativePath);
      continue;
    }
    try {
      JSON.parse(bytes.toString("utf8"));
    } catch {
      unparseable.push(relativePath);
    }
  }
  const concerns: PromotionBenchmarkPrediction["concerns"] = [
    ...(missing.length > 0
      ? [{ code: "required_artifact_missing", severity: "blocking" as const, evidence_refs: missing }]
      : []),
    ...(unparseable.length > 0
      ? [{ code: "required_artifact_unparseable", severity: "blocking" as const, evidence_refs: unparseable }]
      : [])
  ];
  return {
    case_id: benchmarkCase.case_id,
    system_id: "presence-checklist",
    trial_id: trialId,
    decision: concerns.length > 0 ? "block" : "promote",
    concerns,
    repair_owners: concerns.length > 0 ? ["review"] : [],
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

function systemDefinition(systemId: PromotionBenchmarkSystemName): {
  system_id: PromotionBenchmarkSystemName;
  protocol: PromotionBenchmarkSystemProtocol;
  ablated_components: string[];
} {
  if (systemId === "always-promote") {
    return { system_id: systemId, protocol: "ungated", ablated_components: [] };
  }
  if (systemId === "presence-checklist") {
    return { system_id: systemId, protocol: "artifact_presence_checklist", ablated_components: [] };
  }
  if (systemId === "artifact-audit") {
    return { system_id: systemId, protocol: "full_artifact_policy", ablated_components: [] };
  }
  return {
    system_id: systemId,
    protocol: "gate_ablation",
    ablated_components: ["concern_to_action_binding"]
  };
}

function parseSystemRunManifest(value: unknown): PromotionBenchmarkSystemRunManifest {
  const currentProtocol = isRecord(value) && value.schema_version === "1.1";
  if (!isRecord(value)
      || (value.schema_version !== "1.0" && value.schema_version !== "1.1")
      || (currentProtocol
        ? value.protocol_revision !== PROMOTION_BENCHMARK_SYSTEM_PROTOCOL_REVISION
        : value.protocol_revision !== undefined)
      || value.status !== "completed"
      || value.evidence_class !== "deterministic_artifact_evaluation"
      || !portableIdentifier(value.suite_id)
      || !nonEmptyString(value.suite_path)
      || !isSha256(value.suite_sha256)
      || !isSha256(value.suite_snapshot_sha256)
      || !portableIdentifier(value.trial_id)
      || !validTimestamp(value.generated_at)
      || !positiveInteger(value.case_count)
      || !positiveInteger(value.prediction_count)
      || !Array.isArray(value.systems)
      || value.systems.length === 0
      || !isRecord(value.artifacts)
      || !nonEmptyString(value.artifacts.predictions_path)
      || !isSha256(value.artifacts.predictions_sha256)) {
    throw new Error("Invalid deterministic promotion system run manifest.");
  }
  assertExactKeys(value, [
    "schema_version",
    ...(currentProtocol ? ["protocol_revision"] : []),
    "status",
    "evidence_class",
    "suite_id",
    "suite_path",
    "suite_sha256",
    "suite_snapshot_sha256",
    "trial_id",
    "generated_at",
    "case_count",
    "prediction_count",
    "systems",
    "artifacts"
  ], "system run manifest");
  assertExactKeys(value.artifacts, ["predictions_path", "predictions_sha256"], "system run artifacts");
  const systems = value.systems.map((entry, index) => {
    if (!isRecord(entry)
        || !(PROMOTION_BENCHMARK_SYSTEMS as readonly unknown[]).includes(entry.system_id)
        || (entry.protocol !== "ungated"
          && entry.protocol !== "artifact_presence_checklist"
          && entry.protocol !== "full_artifact_policy"
          && entry.protocol !== "gate_ablation")
        || !Array.isArray(entry.ablated_components)
        || entry.ablated_components.some((item) => !portableIdentifier(item))) {
      throw new Error("Invalid system run protocol entry " + (index + 1) + ".");
    }
    assertExactKeys(entry, ["system_id", "protocol", "ablated_components"], "system run protocol");
    return {
      system_id: entry.system_id as PromotionBenchmarkSystemName,
      protocol: entry.protocol as PromotionBenchmarkSystemProtocol,
      ablated_components: entry.ablated_components as string[]
    };
  });
  if (new Set(systems.map((system) => system.system_id)).size !== systems.length
      || value.prediction_count !== value.case_count * systems.length) {
    throw new Error("System run manifest system identifiers or prediction count are invalid.");
  }
  return {
    schema_version: currentProtocol ? "1.1" : "1.0",
    protocol_revision: currentProtocol ? PROMOTION_BENCHMARK_SYSTEM_PROTOCOL_REVISION : null,
    status: "completed",
    evidence_class: "deterministic_artifact_evaluation",
    suite_id: value.suite_id,
    suite_path: value.suite_path,
    suite_sha256: value.suite_sha256,
    suite_snapshot_sha256: value.suite_snapshot_sha256,
    trial_id: value.trial_id,
    generated_at: value.generated_at,
    case_count: value.case_count,
    prediction_count: value.prediction_count,
    systems,
    artifacts: {
      predictions_path: value.artifacts.predictions_path,
      predictions_sha256: value.artifacts.predictions_sha256
    }
  };
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], context: string): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new Error("Unexpected fields in " + context + ".");
  }
}

async function resolveExistingInside(root: string, candidate: string, label: string): Promise<string> {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(label + " must be inside the workspace.");
  }
  const realPath = await fs.realpath(candidate);
  const realRelative = path.relative(root, realPath);
  if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(label + " must resolve inside the workspace.");
  }
  return realPath;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath: string): Promise<string> {
  return fs.readFile(filePath).then(sha256);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function portableIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function portableRef(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath).replace(/\\/gu, "/");
  return relative && !relative.startsWith("../") ? relative : "<external-output>";
}
