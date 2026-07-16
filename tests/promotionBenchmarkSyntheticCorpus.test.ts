import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { loadPromotionBenchmarkSuite } from "../src/core/benchmark/promotionBenchmark.js";
import { buildPromotionBenchmarkSuite } from "../src/core/benchmark/promotionBenchmarkBuilder.js";
import { generateSyntheticPromotionCorpus } from "../src/core/benchmark/promotionBenchmarkSyntheticCorpus.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("synthetic promotion development corpus", () => {
  it("generates four base bundles and forty development cases with an explicit evidence ceiling", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-synthetic-corpus-"));
    tempDirs.push(workspace);
    const corpus = await generateSyntheticPromotionCorpus({
      cwd: workspace,
      outDir: "corpus"
    });
    const manifest = JSON.parse(await readFile(path.join(workspace, corpus.corpus_manifest_path), "utf8")) as {
      evidence_class: string;
      paper_claim_eligible: boolean;
      adjudication_status: string;
    };
    expect(corpus).toMatchObject({ base_bundle_count: 4, case_count: 40 });
    expect(manifest).toMatchObject({
      evidence_class: "synthetic_development",
      paper_claim_eligible: false,
      adjudication_status: "unreviewed"
    });

    const suite = await buildPromotionBenchmarkSuite({
      cwd: workspace,
      recipePath: corpus.recipe_path,
      outDir: "suite"
    });
    const loaded = await loadPromotionBenchmarkSuite(path.join(workspace, suite.suite_path));
    expect(loaded.issues).toEqual([]);
    expect(loaded.suite?.cases).toHaveLength(40);
    expect(new Set(loaded.suite?.cases.map((benchmarkCase) => benchmarkCase.base_bundle_id))).toHaveProperty("size", 4);
    expect(loaded.suite?.cases.filter((benchmarkCase) => !benchmarkCase.mutation_family)).toHaveLength(4);
  });
});
