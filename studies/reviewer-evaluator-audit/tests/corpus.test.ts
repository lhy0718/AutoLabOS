import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  auditCorpus,
  groundTruthContextProfile,
  hashCanonical,
  parseInsertedError,
  parsePublishedJudgeDecision,
  parsePublishedScore,
  parseStructuredJudgeVerdicts,
} from "../lib/corpus.mjs";
import {
  changedModifiedSentences,
  normalizedTokenSimilarity,
  paperSpecifiedDetection,
  publishedCodeDetection,
  publishedCodeTokenSimilarity,
  tokenSimilarityExceeds,
} from "../lib/evaluation.mjs";
import { rescorePublicPredictions } from "../lib/rescore.mjs";

describe("reviewer evaluator corpus audit", () => {
  it("parses paired edits and measures unchanged context conservatively", () => {
    const parsed = parseInsertedError([
      ":original_text:",
      "Stable sentence. Earlier assertion.",
      "",
      ":modified_text:",
      "Stable sentence. Revised assertion.",
      "",
      ":explanation:",
      "The assertion changed.",
    ].join("\n"));

    const profile = groundTruthContextProfile(
      parsed.original_text,
      parsed.modified_text,
    );
    expect(profile).toMatchObject({
      pair_count: 1,
      changed_modified_sentence_count: 1,
    });
    expect(profile.unchanged_modified_word_count).toBe(2);
    expect(changedModifiedSentences(parsed.original_text, parsed.modified_text))
      .toEqual(["Revised assertion."]);
  });

  it("reproduces published score and judge decisions", () => {
    const score = parsePublishedScore([
      "subsets of ground vs pred:",
      "[0.1, 0.7]",
      "",
      "subsets of pred vs ground:",
      "[0.2]",
    ].join("\n"));
    expect(score).toMatchObject({ maximum: 0.7, identified: true });

    const judge = [
      "candidate one: INCORRECTLY IDENTIFIED",
      "candidate two: CORRECTLY IDENTIFIED",
    ].join("\n");
    expect(parsePublishedJudgeDecision(judge)).toBe(true);
    expect(parseStructuredJudgeVerdicts(judge)).toEqual([false, true]);
  });

  it("fails corpus authorization when declared artifacts are incomplete", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reviewer-evaluator-audit-"));
    const bundleRoot = path.join(root, "bundle");
    await mkdir(path.join(bundleRoot, "inserted_error"), { recursive: true });
    await mkdir(path.join(bundleRoot, "location_error"), { recursive: true });
    await mkdir(path.join(bundleRoot, "evaluation_errors"), { recursive: true });
    await writeFile(
      path.join(bundleRoot, "metadata.json"),
      JSON.stringify({ paper_alpha: "0" }),
      "utf8",
    );
    await writeFile(
      path.join(bundleRoot, "inserted_error", "paper_alpha_0_inserter.txt"),
      ":original_text:\nStable sentence.\n:modified_text:\nChanged sentence.\n:explanation:\nChanged.",
      "utf8",
    );
    await writeFile(
      path.join(bundleRoot, "location_error", "paper_alpha_0_inserter.txt"),
      "error:\nChanged sentence.",
      "utf8",
    );
    await writeFile(
      path.join(bundleRoot, "evaluation_errors", "paper_alpha_0_model_alpha.txt"),
      ":error_text:\nChanged sentence.",
      "utf8",
    );
    await writeFile(
      path.join(bundleRoot, "evaluation_errors", "paper_alpha_0_model_alpha_score.txt"),
      "subsets of ground vs pred:\n[1]",
      "utf8",
    );
    await writeFile(
      path.join(bundleRoot, "evaluation_errors", "paper_alpha_0_model_alpha_comparison.txt"),
      "candidate: CORRECTLY IDENTIFIED",
      "utf8",
    );
    const config = fixtureConfig();
    const complete = auditCorpus({ config, corpusRoot: root });
    expect(complete).toMatchObject({
      corpus_eligible: true,
      decision: "protocol_freeze_may_proceed",
      complete_prediction_cell_count: 1,
    });
    const { content_sha256: contentHash, ...payload } = complete;
    expect(contentHash).toBe(hashCanonical(payload));

    await writeFile(
      path.join(bundleRoot, "metadata.json"),
      JSON.stringify({ paper_alpha: "0", paper_beta: "1" }),
      "utf8",
    );
    const incomplete = auditCorpus({ config, corpusRoot: root });
    expect(incomplete.corpus_eligible).toBe(false);
    expect(incomplete.gates.declared_bundle_counts_match.pass).toBe(false);
    expect(incomplete.missing_required_artifact_count).toBeGreaterThan(0);
  });
});

describe("metric conformance", () => {
  it("exposes prefix maximization in the published implementation", () => {
    expect(normalizedTokenSimilarity("alpha", "alpha beta gamma"))
      .toBeCloseTo(1 / 3);
    expect(publishedCodeTokenSimilarity("alpha", "alpha beta gamma"))
      .toBe(1);
  });

  it("keeps strict-threshold bounded scoring equivalent to exact similarity", () => {
    const examples = [
      ["alpha beta", "alpha beta"],
      ["alpha beta", "alpha gamma"],
      ["alpha", "alpha beta gamma"],
      ["", ""],
    ];
    for (const [left, right] of examples) {
      expect(tokenSimilarityExceeds(left, right, 0.5)).toBe(
        normalizedTokenSimilarity(left, right) > 0.5,
      );
    }
  });

  it("enumerates interior contiguous sentence spans from the paper specification", () => {
    const result = paperSpecifiedDetection({
      truthSpans: ["Opening context. Central changed assertion. Closing context."],
      predictions: ["Central changed assertion."],
    });
    expect(result.identified).toBe(true);
  });

  it("reproduces the published empty-prediction fail-open behavior", () => {
    const result = publishedCodeDetection({
      truthSpans: ["A concrete target sentence."],
      predictions: [],
    });
    expect(result).toMatchObject({
      identified: true,
      empty_prediction_fail_open: true,
    });
  });
});

describe("public prediction rescoring", () => {
  it("produces a deterministic, content-addressed evaluator decomposition", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reviewer-rescore-"));
    const bundleRoot = path.join(root, "bundle");
    const evaluationRoot = path.join(bundleRoot, "evaluation_errors");
    await mkdir(path.join(bundleRoot, "inserted_error"), { recursive: true });
    await mkdir(path.join(bundleRoot, "location_error"), { recursive: true });
    await mkdir(evaluationRoot, { recursive: true });
    await writeFile(
      path.join(bundleRoot, "metadata.json"),
      JSON.stringify({ paper_alpha: "0" }),
      "utf8",
    );
    await writeFile(
      path.join(bundleRoot, "inserted_error", "paper_alpha_0_inserter.txt"),
      [
        ":original_text:",
        "Stable context. Original assertion.",
        ":modified_text:",
        "Stable context. Changed assertion.",
        ":explanation:",
        "The assertion changed.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(bundleRoot, "location_error", "paper_alpha_0_inserter.txt"),
      "error:\nStable context. Changed assertion.",
      "utf8",
    );
    await writeFile(
      path.join(evaluationRoot, "paper_alpha_0_model_alpha.txt"),
      ":error_text:\nChanged assertion.",
      "utf8",
    );
    await writeFile(
      path.join(evaluationRoot, "paper_alpha_0_model_alpha_score.txt"),
      "subsets of ground vs pred:\n[0.25]\n\nsubsets of pred vs ground:\n[0.25]",
      "utf8",
    );
    await writeFile(
      path.join(evaluationRoot, "paper_alpha_0_model_alpha_comparison.txt"),
      "candidate: CORRECTLY IDENTIFIED",
      "utf8",
    );

    const first = rescorePublicPredictions({
      config: fixtureConfig(),
      corpusRoot: root,
    });
    const second = rescorePublicPredictions({
      config: fixtureConfig(),
      corpusRoot: root,
    });
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      schema_version: 2,
      cell_count: 1,
      diagnostics: {
        stored_vs_replayed_code_decision_disagreement_count: 1,
      },
      rows: [{
        stored_published_lexical: false,
        replayed_published_code_lexical: true,
        paper_specified_focal_truth_lexical: true,
        insertion_model_judge: true,
        published_combined: true,
        changed_modified_sentence_count: 1,
        official_location_span_count: 1,
        focal_truth_span_count: 2,
      }],
    });
    expect(first.rows[0].k_curves.published_combined).toHaveLength(10);
    expect(first.rows[0].k_curves.paper_specified_focal_truth_lexical)
      .toHaveLength(10);
    const { content_sha256: contentHash, ...payload } = first;
    expect(contentHash).toBe(hashCanonical(payload));
  });
});

function fixtureConfig() {
  return {
    source: {
      dataset_id: "fixture/dataset",
      revision: "a".repeat(40),
    },
    bundles: [{
      bundle_id: "family_a",
      root_directory: "bundle",
      metadata_file: "metadata.json",
      insertion_model: "inserter",
      expected_instance_count: 1,
    }],
    identification_models: ["model_alpha"],
    published_evaluation: {
      top_k: 10,
      lexical_threshold: 0.5,
    },
    corpus_gates: {
      minimum_error_instances: 1,
      minimum_unique_papers: 1,
      minimum_insertion_families: 1,
      minimum_complete_prediction_cells: 1,
      maximum_missing_required_artifacts: 0,
    },
  };
}
