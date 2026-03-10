import path from "node:path";

import { RunRecord } from "../types.js";

export function buildPublicRunOutputDir(
  workspaceRoot: string,
  run: Pick<RunRecord, "id" | "title">
): string {
  const slug = sanitizeSlug(run.title) || "run";
  return path.join(workspaceRoot, "outputs", `${slug}-${run.id.slice(0, 8)}`);
}

export function buildPublicExperimentDir(
  workspaceRoot: string,
  run: Pick<RunRecord, "id" | "title">
): string {
  return path.join(buildPublicRunOutputDir(workspaceRoot, run), "experiment");
}

export function buildPublicPaperDir(
  workspaceRoot: string,
  run: Pick<RunRecord, "id" | "title">
): string {
  return path.join(buildPublicRunOutputDir(workspaceRoot, run), "paper");
}

export function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
