import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { analyzePromotionBenchmarkFailures } from "../src/core/benchmark/promotionBenchmarkMetaHarness.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("promotion benchmark meta-harness", () => {
  it("turns decision, blocker, and repair-owner failures into node strengthening artifacts", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-meta-harness-"));
    tempDirs.push(workspace);
    await mkdir(path.join(workspace, "cases"), { recursive: true });
    await mkdir(path.join(workspace, "artifacts", "case-clean"), { recursive: true });
    await mkdir(path.join(workspace, "artifacts", "case-budget"), { recursive: true });
    await writeFile(path.join(workspace, "suite.json"), JSON.stringify({
      schema_version: "1.0",
      suite_id: "meta-harness-suite",
      cases: ["cases/case-clean.json", "cases/case-budget.json"]
    }));
    await writeCase(workspace, {
      case_id: "case-clean",
      base_bundle_id: "base-clean",
      artifact_root: "../artifacts/case-clean",
      gold: { decision: "promote", blocking_concerns: [], repair_owners: [] }
    });
    await writeCase(workspace, {
      case_id: "case-budget",
      base_bundle_id: "base-budget",
      artifact_root: "../artifacts/case-budget",
      mutation_family: "executed_budget_mismatch",
      gold: {
        decision: "block",
        blocking_concerns: ["budget_contract_mismatch"],
        repair_owners: ["run_experiments"]
      }
    });
    await writeFile(path.join(workspace, "predictions.jsonl"), [
      {
        case_id: "case-clean",
        system_id: "artifact-audit",
        trial_id: "trial-alpha",
        decision: "block",
        concerns: [{ code: "unexpected_blocker", severity: "blocking", evidence_refs: ["artifact.json"] }],
        repair_owners: ["review"]
      },
      {
        case_id: "case-budget",
        system_id: "artifact-audit",
        trial_id: "trial-alpha",
        decision: "promote",
        concerns: [],
        repair_owners: []
      }
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");

    const result = await analyzePromotionBenchmarkFailures({
      cwd: workspace,
      suitePath: "suite.json",
      predictionsPath: "predictions.jsonl",
      systemId: "artifact-audit",
      outDir: "meta-output"
    });

    expect(result).toMatchObject({ failed_case_count: 2, recommendation_count: 2 });
    const recommendations = JSON.parse(
      await readFile(path.join(workspace, result.recommendations_path), "utf8")
    ) as { recommendations: Array<{ node: string; diagnostic_ids: string[] }> };
    expect(recommendations.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ node: "review" }),
      expect.objectContaining({ node: "run_experiments" })
    ]));
    const diagnostics = await readFile(path.join(workspace, result.diagnostics_path), "utf8");
    expect(diagnostics).toContain("executed_budget_mismatch");
    expect(diagnostics).toContain("budget_contract_mismatch");
  });
});

async function writeCase(workspace: string, input: {
  case_id: string;
  base_bundle_id: string;
  artifact_root: string;
  mutation_family?: string;
  gold: Record<string, unknown>;
}): Promise<void> {
  await writeFile(path.join(workspace, "cases", `${input.case_id}.json`), JSON.stringify({
    schema_version: "1.0",
    case_id: input.case_id,
    base_bundle_id: input.base_bundle_id,
    split: "development",
    artifact_root: input.artifact_root,
    ...(input.mutation_family ? { mutation_family: input.mutation_family } : {}),
    gold: input.gold
  }));
}
