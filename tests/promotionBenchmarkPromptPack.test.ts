import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { buildPromotionBenchmarkSuite } from "../src/core/benchmark/promotionBenchmarkBuilder.js";
import {
  exportPromotionBenchmarkPromptPack,
  importPromotionBenchmarkResponses
} from "../src/core/benchmark/promotionBenchmarkPromptPack.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("promotion benchmark manuscript-only prompt pack", () => {
  it("exports opaque manuscript-only requests and privately maps provider responses", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-prompts-"));
    tempDirs.push(workspace);
    await mkdir(path.join(workspace, "bundle", "paper"), { recursive: true });
    await writeFile(path.join(workspace, "bundle", "paper", "main.tex"), "\\section{Results}\nA measured comparison is reported.\n", "utf8");
    await writeFile(path.join(workspace, "bundle", "result_table.json"), '[{"baseline":0.6,"comparator":0.7}]\n', "utf8");
    await writeFile(path.join(workspace, "recipe.json"), JSON.stringify({
      schema_version: "1.0",
      suite_id: "blind-suite",
      cases: [
        {
          case_id: "case-control-a",
          base_bundle_id: "base-alpha",
          split: "test",
          source_root: "bundle",
          operations: [],
          gold: { decision: "promote", blocking_concerns: [], repair_owners: [] }
        },
        {
          case_id: "case-variant-b",
          base_bundle_id: "base-alpha",
          split: "test",
          source_root: "bundle",
          mutation_family: "comparison_evidence_gap",
          operations: [{ op: "remove_json_pointer", path: "result_table.json", pointer: "/0/comparator" }],
          gold: {
            decision: "block",
            blocking_concerns: ["baseline_or_comparator_missing"],
            repair_owners: ["design_experiments"]
          }
        }
      ]
    }));
    const suite = await buildPromotionBenchmarkSuite({
      cwd: workspace,
      recipePath: "recipe.json",
      outDir: "suite"
    });

    const exported = await exportPromotionBenchmarkPromptPack({
      cwd: workspace,
      suitePath: suite.suite_path,
      outDir: "prompt-pack"
    });
    const requestText = await readFile(path.join(workspace, exported.requests_path), "utf8");
    expect(requestText).toContain("manuscript-only-v1");
    expect(requestText).not.toContain("case-control-a");
    expect(requestText).not.toContain("case-variant-b");
    expect(requestText).not.toContain("comparison_evidence_gap");
    expect(requestText).not.toContain("result_table.json");

    const privateMap = JSON.parse(await readFile(path.join(workspace, exported.private_map_path), "utf8")) as {
      requests: Array<{ request_id: string; case_id: string }>;
    };
    const responses = privateMap.requests.map((request) => ({
      request_id: request.request_id,
      decision: "needs_review",
      concerns: [{ code: "manuscript_evidence_uncertain", severity: "warning", evidence_refs: ["manuscript"] }],
      repair_owners: ["review"],
      latency_ms: 12,
      cost_usd: 0.001
    }));
    await writeFile(path.join(workspace, "responses.jsonl"), `${responses.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    const imported = await importPromotionBenchmarkResponses({
      cwd: workspace,
      requestMapPath: exported.private_map_path,
      responsesPath: "responses.jsonl",
      systemId: "provider-manuscript-only",
      trialId: "trial-alpha",
      outDir: "provider-predictions"
    });
    const predictions = (await readFile(path.join(workspace, imported.predictions_path), "utf8")).trim().split("\n");
    expect(predictions).toHaveLength(2);
    expect(predictions.map((line) => JSON.parse(line))).toEqual(expect.arrayContaining([
      expect.objectContaining({ case_id: "case-control-a", system_id: "provider-manuscript-only" }),
      expect.objectContaining({ case_id: "case-variant-b", system_id: "provider-manuscript-only" })
    ]));
  });

  it("rejects incomplete provider response sets", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-prompts-incomplete-"));
    tempDirs.push(workspace);
    await writeFile(path.join(workspace, "map.json"), JSON.stringify({
      schema_version: "1.0",
      suite_id: "suite-alpha",
      protocol: "manuscript-only-v1",
      requests_sha256: "b".repeat(64),
      requests: [
        {
          request_id: "request-alpha",
          case_id: "case-alpha",
          manuscript_sha256: "a".repeat(64),
          prompt_sha256: "c".repeat(64)
        }
      ]
    }));
    await writeFile(path.join(workspace, "responses.jsonl"), "", "utf8");

    await expect(importPromotionBenchmarkResponses({
      cwd: workspace,
      requestMapPath: "map.json",
      responsesPath: "responses.jsonl",
      systemId: "provider-alpha",
      trialId: "trial-alpha",
      outDir: "predictions"
    })).rejects.toThrow("incomplete");
  });
});
