import path from "node:path";

import { promises as fs } from "node:fs";

const EXECUTION_SUMMARY_ARTIFACTS_INVALIDATED_BY_DESIGN = [
  "run_manifest.json",
  "run_experiments_verify_report.json",
  "objective_evaluation.json",
  "run_experiments_matrix_trial_groups.json",
  "run_experiments_supplemental_expectation.json",
  "run_experiments_supplemental_runs.json"
] as const;

export async function clearExecutionSummaryArtifactsInvalidatedByDesign(runDir: string): Promise<string[]> {
  const removed: string[] = [];
  for (const relativePath of EXECUTION_SUMMARY_ARTIFACTS_INVALIDATED_BY_DESIGN) {
    const artifactPath = path.join(runDir, relativePath);
    try {
      await fs.rm(artifactPath, { force: true });
      removed.push(relativePath);
    } catch {
      // Best-effort cleanup: missing/stale artifacts should not block design generation.
    }
  }
  return removed;
}
