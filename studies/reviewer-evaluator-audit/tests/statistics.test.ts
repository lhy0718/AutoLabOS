import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { analyzeEvaluatorSensitivity } from "../lib/analyze.mjs";
import { hashCanonical } from "../lib/corpus.mjs";
import {
  clusterPercentileBootstrap,
  createDeterministicPrng,
  fitAdjustedLogisticMle,
  fitAdjustedRankingAcrossK,
  kendallTauB,
  pairwiseOrderReversals,
  samplePaperClusters,
  summarizeConditionRates,
  validateKCurveRows,
} from "../lib/statistics.mjs";

const DEPTHS = Array.from({ length: 10 }, (_, index) => index + 1);
const REFERENCE_CONDITION = "reference_condition";
const COMPARISON_CONDITION = "comparison_condition";
const SECONDARY_CONDITION = "secondary_condition";
const INSERTION_REFERENCE = "reference_family";
const execFileAsync = promisify(execFile);

describe("adjusted logistic ranking", () => {
  it("fits the fixed-intercept model and excludes same-model cells", () => {
    const rows = balancedRows();
    const fit = fitAdjustedLogisticMle({
      rows,
      conditionId: REFERENCE_CONDITION,
      retrievalDepths: DEPTHS,
      k: 1,
      fixedIntercept: -3,
      insertionReference: INSERTION_REFERENCE,
    });

    expect(fit.status).toBe("ok");
    expect(fit.fixed_intercept).toBe(-3);
    expect(fit.excluded_same_model_count).toBe(48);
    expect(fit.identification_effects.control_system).toBeCloseTo(
      3 + Math.log(3),
      6,
    );
    expect(fit.identification_effects.candidate_system).toBeCloseTo(3, 6);
    expect(fit.identification_effects.alternate_system).toBeCloseTo(
      3 - Math.log(3),
      6,
    );
    expect(fit.insertion_family_effects.comparison_family).toBeCloseTo(0, 6);
    expect(fit.identification_effects.control_system)
      .toBeGreaterThan(fit.identification_effects.candidate_system);
    expect(fit.identification_effects.candidate_system)
      .toBeGreaterThan(fit.identification_effects.alternate_system);

    const ranking = fitAdjustedRankingAcrossK({
      rows,
      conditionId: REFERENCE_CONDITION,
      retrievalDepths: DEPTHS,
      fixedIntercept: -3,
      insertionReference: INSERTION_REFERENCE,
    });
    expect(ranking.status).toBe("ok");
    expect(ranking.per_k).toHaveLength(10);
    expect(ranking.ranking.top_1_model).toBe("control_system");
  });

  it("blocks separation and non-convergence instead of substituting an estimator", () => {
    const separatedRows = balancedRows().map((row) => ({
      ...row,
      k_curves: {
        ...row.k_curves,
        [REFERENCE_CONDITION]:
          row.identification_model === "control_system"
            ? Array(10).fill(false)
            : row.k_curves[REFERENCE_CONDITION],
      },
    }));
    const separated = fitAdjustedLogisticMle({
      rows: separatedRows,
      conditionId: REFERENCE_CONDITION,
      retrievalDepths: DEPTHS,
      k: 1,
      fixedIntercept: -3,
      insertionReference: INSERTION_REFERENCE,
    });
    expect(separated).toMatchObject({
      status: "blocked",
      failure_kind: "separation",
      converged: false,
      identification_effects: null,
    });

    const nonConverged = fitAdjustedLogisticMle({
      rows: balancedRows(),
      conditionId: REFERENCE_CONDITION,
      retrievalDepths: DEPTHS,
      k: 1,
      fixedIntercept: -3,
      insertionReference: INSERTION_REFERENCE,
      maxIterations: 1,
    });
    expect(nonConverged).toMatchObject({
      status: "blocked",
      failure_kind: "non_convergence",
      converged: false,
    });
  });
});

describe("ranking sensitivity", () => {
  it("computes Kendall tau-b and strict pairwise reversals", () => {
    const reference = {
      control_system: 3,
      candidate_system: 2,
      alternate_system: 1,
    };
    const reversed = {
      control_system: 1,
      candidate_system: 2,
      alternate_system: 3,
    };
    expect(kendallTauB(reference, reversed)).toMatchObject({
      status: "ok",
      tau_b: -1,
      concordant: 0,
      discordant: 3,
    });
    const reversals = pairwiseOrderReversals(reference, reversed);
    expect(reversals.reversal_count).toBe(3);
    expect(reversals.tie_change_count).toBe(0);
  });

  it("reports top-k rates, paired flips, and directional differences", () => {
    const rows = balancedRows();
    const summary = summarizeConditionRates({
      rows,
      conditionId: COMPARISON_CONDITION,
      referenceConditionId: REFERENCE_CONDITION,
      retrievalDepths: DEPTHS,
    });
    expect(summary.top_k).toHaveLength(10);
    expect(summary.top_k[9]).toMatchObject({
      k: 10,
      cell_count: 144,
      positive_count: 72,
      reference_positive_count: 72,
      flip_count: 48,
      flip_rate: 1 / 3,
      rate_difference: 0,
    });
  });
});

describe("cluster bootstrap", () => {
  it("samples paper clusters deterministically and retains multiplicity", () => {
    const rows = [
      { paper_id: "paper_one", value: 1 },
      { paper_id: "paper_one", value: 2 },
      { paper_id: "paper_two", value: 3 },
      { paper_id: "paper_three", value: 4 },
    ];
    const draws = [0, 0, 0.99];
    const sample = samplePaperClusters(rows, {
      prng: () => draws.shift() ?? 0,
    });
    expect(sample.sampled_cluster_ids).toEqual([
      "paper_one",
      "paper_one",
      "paper_two",
    ]);
    expect(sample.multiplicities).toEqual({
      paper_one: 2,
      paper_two: 1,
    });
    expect(sample.rows.map((row) => row.value)).toEqual([1, 2, 1, 2, 3]);

    const first = createDeterministicPrng(17);
    const second = createDeterministicPrng(17);
    expect(Array.from({ length: 8 }, () => first()))
      .toEqual(Array.from({ length: 8 }, () => second()));
  });

  it("produces deterministic percentile intervals and order probabilities", () => {
    const options = {
      rows: balancedRows(),
      conditionIds: [REFERENCE_CONDITION, COMPARISON_CONDITION],
      referenceConditionId: REFERENCE_CONDITION,
      retrievalDepths: DEPTHS,
      fixedIntercept: -3,
      insertionReference: INSERTION_REFERENCE,
      resamples: 24,
      seed: 20260728,
      confidenceLevel: 0.95,
    };
    const first = clusterPercentileBootstrap(options);
    const second = clusterPercentileBootstrap(options);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      status: "ok",
      cluster_count: 6,
      completed_resamples: 24,
      retains_cluster_multiplicity: true,
    });
    expect(
      first.summaries[REFERENCE_CONDITION]
        .unique_top_1_probability.control_system,
    ).toBe(1);
    expect(
      first.summaries[COMPARISON_CONDITION]
        .unique_top_1_probability.alternate_system,
    ).toBe(1);
    expect(
      first.summaries[REFERENCE_CONDITION].top_k[9],
    ).toMatchObject({
      k: 10,
      positive_rate_interval: { lower: 0.5, upper: 0.5 },
    });
    const pair = first.summaries[REFERENCE_CONDITION]
      .pairwise_order_probability
      .find((item) =>
        item.first_model === "alternate_system"
        && item.second_model === "control_system");
    expect(pair.first_above).toBe(0);
    expect(pair.second_above).toBe(1);
  });
});

describe("fail-closed analysis artifact", () => {
  it("analyzes every protocol condition without experiment-specific code", () => {
    const rows = balancedRows();
    const protocol = fixtureProtocol(rows);
    const input = contentAddressedInput(rows);
    const artifact = analyzeEvaluatorSensitivity({ protocol, input });

    expect(artifact.analysis_status).toBe("complete");
    expect(artifact.protocol_conformant_resample_count).toBe(true);
    expect(Object.keys(artifact.conditions)).toEqual([
      REFERENCE_CONDITION,
      COMPARISON_CONDITION,
      SECONDARY_CONDITION,
    ]);
    expect(
      artifact.conditions[COMPARISON_CONDITION]
        .ranking_sensitivity_vs_reference
        .pairwise_order_reversals
        .reversal_count,
    ).toBe(3);
    const { content_sha256: contentHash, ...payload } = artifact;
    expect(contentHash).toBe(hashCanonical(payload));
  });

  it("blocks missing, non-monotone, duplicate, and tampered inputs", () => {
    const rows = balancedRows();
    const missing = structuredClone(rows);
    delete missing[0].k_curves[COMPARISON_CONDITION];
    expect(() => validateKCurveRows({
      rows: missing,
      conditionIds: [REFERENCE_CONDITION, COMPARISON_CONDITION],
      retrievalDepths: DEPTHS,
    })).toThrow(/comparison_condition is missing/u);

    const nonMonotone = structuredClone(rows);
    nonMonotone[0].k_curves[REFERENCE_CONDITION] = [
      true,
      false,
      ...Array(8).fill(false),
    ];
    expect(() => validateKCurveRows({
      rows: nonMonotone,
      conditionIds: [REFERENCE_CONDITION],
      retrievalDepths: DEPTHS,
    })).toThrow(/not cumulative/u);

    expect(() => validateKCurveRows({
      rows: [...rows, structuredClone(rows[0])],
      conditionIds: [REFERENCE_CONDITION],
      retrievalDepths: DEPTHS,
    })).toThrow(/duplicate evaluation cell/u);

    const protocol = fixtureProtocol(rows);
    const input = contentAddressedInput(rows);
    input.rows[0].k_curves[REFERENCE_CONDITION][0] =
      !input.rows[0].k_curves[REFERENCE_CONDITION][0];
    const blocked = analyzeEvaluatorSensitivity({ protocol, input });
    expect(blocked).toMatchObject({
      analysis_status: "blocked",
      fail_closed: true,
      failures: [{
        scope: "input_or_protocol_validation",
        failure_kind: "content_hash_mismatch",
      }],
    });

    const missingInput = contentAddressedInput(missing);
    const missingBlocked = analyzeEvaluatorSensitivity({
      protocol,
      input: missingInput,
    });
    expect(missingBlocked.failures[0]).toMatchObject({
      scope: "input_or_protocol_validation",
      failure_kind: "missing_data",
    });

    expect(analyzeEvaluatorSensitivity({ protocol: null, input })).toMatchObject({
      analysis_status: "blocked",
      protocol_sha256: null,
      failures: [{ failure_kind: "invalid_protocol" }],
    });
  });

  it("runs the CLI and writes one content-addressed artifact atomically", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "evaluator-statistics-"));
    try {
      const rows = balancedRows();
      const protocolPath = path.join(root, "protocol.json");
      const inputPath = path.join(root, "input.json");
      const outputPath = path.join(root, "analysis.json");
      await writeFile(
        protocolPath,
        JSON.stringify(fixtureProtocol(rows)),
        "utf8",
      );
      await writeFile(
        inputPath,
        JSON.stringify(contentAddressedInput(rows)),
        "utf8",
      );
      const { stdout } = await execFileAsync(process.execPath, [
        path.resolve(
          "studies/reviewer-evaluator-audit/scripts/analyze-evaluator-sensitivity.mjs",
        ),
        "--protocol",
        protocolPath,
        "--input",
        inputPath,
        "--output",
        outputPath,
      ], { cwd: process.cwd() });
      const summary = JSON.parse(stdout.trim());
      const artifact = JSON.parse(await readFile(outputPath, "utf8"));
      expect(summary.analysis_status).toBe("complete");
      expect(artifact.content_sha256).toBe(summary.content_sha256);
      expect((await readdir(root)).some((name) => name.includes(".tmp-")))
        .toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function balancedRows() {
  const systems = [
    "control_system",
    "candidate_system",
    "alternate_system",
  ];
  const families = [
    {
      id: INSERTION_REFERENCE,
      insertion_model: "control_system",
    },
    {
      id: "comparison_family",
      insertion_model: "alternate_system",
    },
  ];
  const referencePositiveCounts = {
    control_system: 3,
    candidate_system: 2,
    alternate_system: 1,
  };
  const comparisonPositiveCounts = {
    control_system: 1,
    candidate_system: 2,
    alternate_system: 3,
  };
  const rows = [];
  for (let paperIndex = 0; paperIndex < 6; paperIndex += 1) {
    for (const family of families) {
      for (const system of systems) {
        for (let claimIndex = 0; claimIndex < 4; claimIndex += 1) {
          const referencePositive =
            claimIndex < referencePositiveCounts[system];
          const comparisonPositive =
            claimIndex < comparisonPositiveCounts[system];
          rows.push({
            bundle_id: family.id,
            insertion_model: family.insertion_model,
            paper_id: `paper_${paperIndex}`,
            claim_index: claimIndex,
            identification_model: system,
            k_curves: {
              [REFERENCE_CONDITION]: Array(10).fill(referencePositive),
              [COMPARISON_CONDITION]: Array(10).fill(comparisonPositive),
              [SECONDARY_CONDITION]: Array(10).fill(referencePositive),
            },
          });
        }
      }
    }
  }
  return rows;
}

function fixtureProtocol(rows) {
  const errorInstances = new Set(rows.map((row) => JSON.stringify([
    row.bundle_id,
    row.paper_id,
    row.claim_index,
  ]))).size;
  return {
    schema_version: 1,
    primary_conditions: [
      { id: REFERENCE_CONDITION, role: "reference" },
      { id: COMPARISON_CONDITION, role: "primary" },
    ],
    secondary_conditions: [SECONDARY_CONDITION],
    units: {
      retrieval_depths: DEPTHS,
      expected_error_instances: errorInstances,
      expected_unique_paper_clusters: 6,
      expected_evaluation_cells: rows.length,
    },
    adjusted_ranking_model: {
      fixed_intercept: -3,
      insertion_reference: INSERTION_REFERENCE,
    },
    uncertainty: {
      method: "percentile cluster bootstrap",
      cluster: "paper_id",
      resamples: 16,
      seed: 20260728,
      confidence_level: 0.95,
    },
  };
}

function contentAddressedInput(rows) {
  const payload = {
    schema_version: 1,
    artifact_kind: "combined_evaluator_fixture",
    rows: structuredClone(rows),
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload),
  };
}
