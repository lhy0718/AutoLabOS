import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runPromotionSourceNormalizationBatchAdjudicationCli,
  runPromotionSourceNormalizationBatchMaterializationCli
} from "../src/cli/governanceBenchmark.js";
import {
  adjudicatePromotionSourceNormalizationBatch,
  type AdjudicatePromotionSourceNormalizationBatchResult
} from "../src/core/benchmark/promotionBenchmarkSourceNormalizationAdjudication.js";
import {
  materializePromotionSourceNormalizationBatch,
  type MaterializePromotionSourceNormalizationBatchResult
} from "../src/core/benchmark/promotionBenchmarkSourceNormalizationMaterialization.js";

vi.mock("../src/core/benchmark/promotionBenchmarkSourceNormalizationAdjudication.js", () => ({
  adjudicatePromotionSourceNormalizationBatch: vi.fn()
}));

vi.mock("../src/core/benchmark/promotionBenchmarkSourceNormalizationMaterialization.js", () => ({
  materializePromotionSourceNormalizationBatch: vi.fn()
}));

const adjudicateMock = vi.mocked(adjudicatePromotionSourceNormalizationBatch);
const materializeMock = vi.mocked(materializePromotionSourceNormalizationBatch);

let previousExitCode: typeof process.exitCode;

beforeEach(() => {
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("governance benchmark CLI", () => {
  it("prints failed adjudication and sets a failing process status", async () => {
    adjudicateMock.mockResolvedValueOnce(adjudicationResult(false));
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await runPromotionSourceNormalizationBatchAdjudicationCli({
      cwd: "/workspace",
      batchRoot: "review-batch",
      annotationPaths: ["annotation-a.jsonl", "annotation-b.jsonl"],
      outDir: "adjudication"
    });

    expect(stdoutFrom(writeSpy)).toContain("Passed: false");
    expect(process.exitCode).toBe(1);
  });

  it("prints passed adjudication without setting a process status", async () => {
    adjudicateMock.mockResolvedValueOnce(adjudicationResult(true));
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await runPromotionSourceNormalizationBatchAdjudicationCli({
      cwd: "/workspace",
      batchRoot: "review-batch",
      annotationPaths: ["annotation-a.jsonl", "annotation-b.jsonl"],
      outDir: "adjudication"
    });

    expect(stdoutFrom(writeSpy)).toContain("Passed: true");
    expect(process.exitCode).toBeUndefined();
  });

  it("prints failed materialization and sets a failing process status", async () => {
    materializeMock.mockResolvedValueOnce(materializationResult(false));
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await runPromotionSourceNormalizationBatchMaterializationCli({
      cwd: "/workspace",
      adjudicationRoot: "adjudication",
      outDir: "materialization"
    });

    expect(stdoutFrom(writeSpy)).toContain("Passed: false");
    expect(process.exitCode).toBe(1);
  });

  it("prints passed materialization without setting a process status", async () => {
    materializeMock.mockResolvedValueOnce(materializationResult(true));
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await runPromotionSourceNormalizationBatchMaterializationCli({
      cwd: "/workspace",
      adjudicationRoot: "adjudication",
      outDir: "materialization"
    });

    expect(stdoutFrom(writeSpy)).toContain("Passed: true");
    expect(process.exitCode).toBeUndefined();
  });
});

function stdoutFrom(writeSpy: ReturnType<typeof vi.spyOn>): string {
  return writeSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
}

function adjudicationResult(passed: boolean): AdjudicatePromotionSourceNormalizationBatchResult {
  return {
    report: {
      schema_version: "1.0",
      generated_at: "2026-01-01T00:00:00.000Z",
      batch_id: "normalization-batch-a",
      passed,
      task_count: 2,
      accepted_label_count: passed ? 2 : 1,
      initial_annotator_ids: ["reviewer-a", "reviewer-b"],
      resolver_id: null,
      disagreement_count: passed ? 0 : 1,
      resolved_disagreement_count: 0,
      agreement: {
        full_label_exact_rate: passed ? 1 : 0.5,
        field_exact_rates: {}
      },
      input_sha256: {
        batch_manifest: "batch-manifest-hash",
        annotations: ["annotation-a-hash", "annotation-b-hash"],
        resolution: null
      },
      outputs: {
        accepted_labels_path: passed ? "adjudication/adjudicated-labels.jsonl" : null,
        accepted_labels_sha256: passed ? "accepted-labels-hash" : null,
        materialization_jobs_path: passed ? "adjudication/materialization-jobs.jsonl" : null,
        materialization_jobs_sha256: passed ? "materialization-jobs-hash" : null
      },
      validation_issues: [],
      evidence_boundary: "Fixture evidence boundary"
    },
    output_dir: "adjudication",
    report_path: "adjudication/report.json",
    accepted_labels_path: passed ? "adjudication/adjudicated-labels.jsonl" : null,
    materialization_jobs_path: passed ? "adjudication/materialization-jobs.jsonl" : null
  };
}

function materializationResult(passed: boolean): MaterializePromotionSourceNormalizationBatchResult {
  return {
    report: {
      schema_version: "1.0",
      generated_at: "2026-01-01T00:00:00.000Z",
      batch_id: "normalization-batch-a",
      passed,
      item_count: 2,
      materialized_count: passed ? 2 : 1,
      failed_count: passed ? 0 : 1,
      input_sha256: {
        adjudication_report: "adjudication-report-hash",
        accepted_labels: "accepted-labels-hash",
        materialization_jobs: "materialization-jobs-hash"
      },
      items: [],
      evidence_boundary: "Fixture evidence boundary"
    },
    output_dir: "materialization",
    report_path: "materialization/report.json"
  };
}
