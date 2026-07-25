import path from "node:path";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";

export const PROMOTION_ARTIFACT_REPAIR_ADAPTER_REVISION = "promotion-artifact-repair-v2";

export type PromotionArtifactRepairOwner =
  | "run_experiments"
  | "analyze_results"
  | "figure_audit";

export interface PromotionArtifactRepairResult {
  owner: PromotionArtifactRepairOwner;
  adapter_revision: typeof PROMOTION_ARTIFACT_REPAIR_ADAPTER_REVISION;
  changed_paths: string[];
}

export async function repairPromotionArtifacts(input: {
  artifactRoot: string;
  owner: PromotionArtifactRepairOwner;
}): Promise<PromotionArtifactRepairResult> {
  const artifactRoot = path.resolve(input.artifactRoot);
  const changed = input.owner === "run_experiments"
    ? await repairExperimentArtifacts(artifactRoot)
    : input.owner === "analyze_results"
      ? await repairAnalysisArtifacts(artifactRoot)
      : await repairFigureAuditArtifacts(artifactRoot);
  return {
    owner: input.owner,
    adapter_revision: PROMOTION_ARTIFACT_REPAIR_ADAPTER_REVISION,
    changed_paths: [...changed].sort()
  };
}

async function repairExperimentArtifacts(artifactRoot: string): Promise<Set<string>> {
  const changed = new Set<string>();
  const evidence = await readJsonObject(artifactRoot, "experiment_evidence.json");
  const record = await readJsonObject(artifactRoot, "run_record.json");
  if (!Array.isArray(evidence.trials) || evidence.trials.length === 0) {
    throw new Error("run_experiments repair requires non-empty experiment trial evidence.");
  }
  const runId = nonEmptyString(record.id) ? record.id : "run";
  let evidenceChanged = false;
  for (const [index, trial] of evidence.trials.entries()) {
    if (!isRecord(trial)) throw new Error("run_experiments repair found an invalid trial record.");
    if (!nonEmptyString(trial.trial_id)) {
      trial.trial_id = `${portableStem(runId)}-trial-${index + 1}`;
      evidenceChanged = true;
    }
  }
  if (evidenceChanged) {
    await writeJsonInside(artifactRoot, "experiment_evidence.json", evidence);
    changed.add("experiment_evidence.json");
  }

  const executedBudget = isRecord(record.executed_budget) ? record.executed_budget : {};
  record.executed_budget = executedBudget;
  if (executedBudget.trials !== evidence.trials.length) {
    executedBudget.trials = evidence.trials.length;
    await writeJsonInside(artifactRoot, "run_record.json", record);
    changed.add("run_record.json");
  }
  return changed;
}

async function repairAnalysisArtifacts(artifactRoot: string): Promise<Set<string>> {
  const changed = new Set<string>();
  const design = await readJsonObject(artifactRoot, "design_contracts.json");
  if (design.sota_ranking_claimed === true && design.sota_evidence_present !== true) {
    design.sota_ranking_claimed = false;
    await writeJsonInside(artifactRoot, "design_contracts.json", design);
    changed.add("design_contracts.json");
  }

  const resultTable = await readJsonValue(artifactRoot, "result_table.json");
  if (hasCompleteResultRow(resultTable)) {
    for (const relativePath of [
      "paper/claim_evidence_table.json",
      "paper/claim_status_table.json"
    ]) {
      const table = await readJsonObject(artifactRoot, relativePath);
      if (!Array.isArray(table.claims)) continue;
      let tableChanged = false;
      for (const claim of table.claims) {
        if (!isRecord(claim)) continue;
        if (!Array.isArray(claim.artifact_refs) || claim.artifact_refs.length === 0) {
          claim.artifact_refs = ["result_table.json"];
          tableChanged = true;
        }
      }
      if (tableChanged) {
        await writeJsonInside(artifactRoot, relativePath, table);
        changed.add(relativePath);
      }
    }

    const evidenceRows = await readJsonLines(artifactRoot, "evidence_store.jsonl");
    const evidenceLinksPath = "paper/evidence_links.json";
    const evidenceLinks = await readJsonObject(artifactRoot, evidenceLinksPath);
    if (Array.isArray(evidenceLinks.claims)) {
      let linksChanged = false;
      for (const claim of evidenceLinks.claims) {
        if (!isRecord(claim) || !nonEmptyString(claim.claim_id)) continue;
        if (Array.isArray(claim.evidence_ids) && claim.evidence_ids.length > 0) continue;
        const evidenceIds = evidenceRows
          .filter((row) => row.claim_id === claim.claim_id
            && row.claim_evidence_valid === true
            && nonEmptyString(row.id)
            && Array.isArray(row.artifact_refs)
            && row.artifact_refs.some(nonEmptyString))
          .map((row) => row.id as string)
          .sort();
        if (evidenceIds.length === 0) continue;
        claim.evidence_ids = [...new Set(evidenceIds)];
        linksChanged = true;
      }
      if (linksChanged) {
        await writeJsonInside(artifactRoot, evidenceLinksPath, evidenceLinks);
        changed.add(evidenceLinksPath);
      }
    }
  }
  return changed;
}

async function repairFigureAuditArtifacts(artifactRoot: string): Promise<Set<string>> {
  const relativePath = "figure_audit/figure_audit_summary.json";
  const summary = await readJsonObject(artifactRoot, relativePath);
  if (!Array.isArray(summary.issues)) {
    throw new Error("figure_audit repair requires an issues array.");
  }
  const severeMismatchCount = summary.issues.filter((issue) =>
    isRecord(issue)
      && (issue.severity === "severe" || issue.severity === "blocking" || issue.blocking === true)
  ).length;
  const reviewBlockRequired = severeMismatchCount > 0;
  if (summary.severe_mismatch_count === severeMismatchCount
      && summary.review_block_required === reviewBlockRequired) {
    return new Set<string>();
  }
  summary.severe_mismatch_count = severeMismatchCount;
  summary.review_block_required = reviewBlockRequired;
  await writeJsonInside(artifactRoot, relativePath, summary);
  return new Set([relativePath]);
}

async function readJsonObject(root: string, relativePath: string): Promise<Record<string, unknown>> {
  const value = await readJsonValue(root, relativePath);
  if (!isRecord(value)) throw new Error(`Repair artifact must be a JSON object: ${relativePath}`);
  return value;
}

async function readJsonValue(root: string, relativePath: string): Promise<unknown> {
  const filePath = resolveRegularFile(root, relativePath);
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Repair artifact must be a regular file: ${relativePath}`);
  }
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readJsonLines(root: string, relativePath: string): Promise<Record<string, unknown>[]> {
  const filePath = resolveRegularFile(root, relativePath);
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Repair artifact must be a regular file: ${relativePath}`);
  }
  return (await fs.readFile(filePath, "utf8"))
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => {
      const row = JSON.parse(line) as unknown;
      if (!isRecord(row)) throw new Error(`Repair artifact contains a non-object JSON line: ${relativePath}`);
      return row;
    });
}

async function writeJsonInside(root: string, relativePath: string, value: unknown): Promise<void> {
  await writeJsonFile(resolveInside(root, relativePath), value);
}

function resolveRegularFile(root: string, relativePath: string): string {
  return resolveInside(root, relativePath);
}

function resolveInside(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const relation = path.relative(root, resolved);
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) {
    throw new Error(`Repair artifact path escapes the case root: ${relativePath}`);
  }
  return resolved;
}

function hasCompleteResultRow(value: unknown): boolean {
  return Array.isArray(value) && value.some((row) =>
    isRecord(row)
      && nonEmptyString(row.metric)
      && finiteNumber(row.baseline)
      && finiteNumber(row.comparator)
      && finiteNumber(row.delta)
  );
}

function portableStem(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return normalized || "run";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
