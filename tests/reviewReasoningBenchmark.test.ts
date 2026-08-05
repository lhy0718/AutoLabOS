import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  buildReviewReasoningBenchmarkPrompt,
  createReviewReasoningBenchmarkSuiteV1,
  deriveReviewReasoningFaults,
  parseReviewReasoningBenchmarkResponse,
  renderReviewReasoningBenchmarkMarkdown,
  runReviewReasoningBenchmark,
  scoreReviewReasoningBenchmarkResponse,
  validateReviewReasoningBenchmarkSuite,
  type ReviewReasoningBenchmarkResponse,
  type ReviewReasoningBenchmarkSplit
} from "../src/core/evaluation/reviewReasoningBenchmark.js";
import type { LLMClient } from "../src/core/llm/client.js";
import { runReviewReasoningBenchmarkCli } from "../src/cli/reviewReasoningBenchmark.js";

describe("review reasoning benchmark", () => {
  it("validates a dry run without requiring an initialized workspace", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "autolabos-review-benchmark-"));
    try {
      const result = await runReviewReasoningBenchmarkCli({
        cwd,
        dryRun: true,
        now: () => new Date("2026-08-05T00:00:00.000Z")
      });
      const preflight = JSON.parse(await readFile(result.preflight_path, "utf8"));

      expect(preflight).toMatchObject({
        artifact_type: "ReviewReasoningBenchmarkPreflight",
        provider: "codex",
        dry_run: true,
        suite_validation: {
          valid: true,
          oracle_replay_passed: true
        }
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("builds a source- and fault-family-disjoint suite with replayed gold", () => {
    const suite = createReviewReasoningBenchmarkSuiteV1();
    const validation = validateReviewReasoningBenchmarkSuite(suite);

    expect(validation).toMatchObject({
      valid: true,
      case_count: 48,
      clean_case_count: 8,
      fault_family_count: 10,
      source_disjoint: true,
      fault_family_disjoint: true,
      oracle_replay_passed: true
    });
    for (const item of suite.cases) {
      expect(deriveReviewReasoningFaults(item.packet)).toEqual(item.injected_fault_ids);
    }
  });

  it("keeps gold labels and mutation metadata out of the model input", () => {
    const suite = createReviewReasoningBenchmarkSuiteV1();
    const prompt = buildReviewReasoningBenchmarkPrompt({ suite, split: "test", repetition: 0 });

    expect(prompt.userPrompt).not.toContain("injected_fault_ids");
    expect(prompt.userPrompt).not.toContain("source_fingerprint");
    expect(prompt.userPrompt).not.toContain("expected_adopted_finding_ids");
    expect(prompt.userPrompt).toContain("case-019");
  });

  it("scores perfect detection and adjudication deterministically", () => {
    const suite = createReviewReasoningBenchmarkSuiteV1();
    const response = buildGoldResponse("test");
    const result = scoreReviewReasoningBenchmarkResponse({ suite, split: "test", response });

    expect(result.score).toMatchObject({
      defect_recall: 1,
      defect_precision: 1,
      clean_case_specificity: 1,
      exact_case_accuracy: 1,
      adjudication_accuracy: 1,
      adjudication_exact_accuracy: 1
    });
  });

  it("rejects duplicate case outputs instead of silently taking one", () => {
    const suite = createReviewReasoningBenchmarkSuiteV1();
    const response = buildGoldResponse("test");
    response.case_reviews.push(response.case_reviews[0]);

    expect(() => parseReviewReasoningBenchmarkResponse(JSON.stringify(response), suite, "test"))
      .toThrow("Invalid or duplicate benchmark case response");
  });

  it("fails closed when a model omits a required case", () => {
    const suite = createReviewReasoningBenchmarkSuiteV1();
    const response = buildGoldResponse("test");
    response.case_reviews.pop();

    expect(() => parseReviewReasoningBenchmarkResponse(JSON.stringify(response), suite, "test"))
      .toThrow("required case reviews");
  });

  it("permits xhigh only when matched held-out runs improve recall without regressions", async () => {
    const llm: LLMClient = {
      async complete(_prompt, opts) {
        const effort = opts?.reasoningEffort;
        const response = buildGoldResponse("test");
        if (effort === "high") {
          for (const item of response.case_reviews.slice(0, 6)) item.findings = [];
        }
        return {
          text: JSON.stringify(response),
          usage: { inputTokens: 100, outputTokens: 20 },
          provenance: {
            provider: "mock",
            requestedModel: "configured-review-model",
            effectiveModel: "configured-review-model",
            reasoningEffort: effort || "default",
            contextMode: "fresh",
            identityBasis: "mock"
          }
        };
      }
    };

    const report = await runReviewReasoningBenchmark({
      llm,
      provider: "mock",
      model: "configured-review-model",
      efforts: ["high", "xhigh", "max"],
      repetitions: 3,
      now: () => new Date("2026-08-04T00:00:00.000Z")
    });

    expect(report.promotion_decisions.find((item) => item.comparison === "xhigh_over_high")?.status)
      .toBe("eligible");
    expect(report.promotion_decisions.find((item) => item.comparison === "max_over_xhigh")?.status)
      .toBe("blocked");
    expect(report.routing_policy_review_allowed).toBe(true);
    expect(report.automatic_policy_change_allowed).toBe(false);
    expect(report.diagnostics.ceiling_effect_detected).toBe(false);
    expect(renderReviewReasoningBenchmarkMarkdown(report)).toContain("internal routing benchmark");
  });

  it("detects a ceiling and blocks a costlier tier even after three matched runs", async () => {
    const llm: LLMClient = {
      async complete(_prompt, opts) {
        return {
          text: JSON.stringify(buildGoldResponse("test")),
          provenance: {
            provider: "mock",
            requestedModel: "configured-review-model",
            effectiveModel: "configured-review-model",
            reasoningEffort: opts?.reasoningEffort || "default",
            contextMode: "fresh",
            identityBasis: "mock"
          }
        };
      }
    };
    const report = await runReviewReasoningBenchmark({
      llm,
      provider: "mock",
      model: "configured-review-model",
      efforts: ["high", "xhigh"],
      repetitions: 3
    });

    expect(report.diagnostics.ceiling_effect_detected).toBe(true);
    expect(report.promotion_decisions[0].status).toBe("blocked");
    expect(report.promotion_decisions[0].reasons)
      .toContain("Benchmark ceiling effect prevents a higher-tier routing decision.");
  });

  it("blocks policy changes for development-only or single-run evidence", async () => {
    const llm: LLMClient = {
      async complete() {
        return { text: JSON.stringify(buildGoldResponse("development")) };
      }
    };
    const report = await runReviewReasoningBenchmark({
      llm,
      provider: "mock",
      model: "configured-review-model",
      efforts: ["high", "xhigh"],
      repetitions: 1,
      split: "development"
    });

    const decision = report.promotion_decisions.find((item) => item.comparison === "xhigh_over_high");
    expect(decision?.status).toBe("blocked");
    expect(decision?.reasons).toContain("Only the held-out test split may change automatic routing policy.");
    expect(decision?.reasons).toContain("At least three matched repetitions are required.");
    expect(decision?.reasons).toContain("Every completed execution requires provider/model/reasoning provenance.");
  });
});

function buildGoldResponse(split: ReviewReasoningBenchmarkSplit): ReviewReasoningBenchmarkResponse {
  const suite = createReviewReasoningBenchmarkSuiteV1();
  const cases = suite.cases.filter((item) => item.split === split);
  const visibleCases = new Set(cases.map((item) => item.case_id));
  const severity = new Map(suite.registry.map((item) => [item.fault_id, item.severity]));
  return {
    case_reviews: cases.map((item) => ({
      case_id: item.case_id,
      findings: item.injected_fault_ids.map((faultId) => ({
        fault_id: faultId,
        severity: severity.get(faultId) || "warning"
      }))
    })),
    adjudications: suite.adjudication_cases
      .filter((item) => visibleCases.has(item.case_id))
      .map((item) => ({
        adjudication_id: item.adjudication_id,
        adopt_finding_ids: item.expected_adopted_finding_ids
      }))
  };
}
