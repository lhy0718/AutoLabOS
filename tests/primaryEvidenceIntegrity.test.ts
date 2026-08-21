import { describe, expect, it } from "vitest";

import { detectPrimaryEvidenceIntegrityViolation } from "../src/core/experiments/primaryEvidenceIntegrity.js";

describe("primary evidence integrity", () => {
  it("blocks a real runner that can promote fallback output as success", () => {
    const runnerSource = [
      "backend = 'synthetic_fallback_backend'",
      "def run_synthetic_fallback_metrics():",
      "    return {'status': 'completed', 'success': True}",
      "def main():",
      "    return run_synthetic_fallback_metrics()"
    ].join("\n");

    expect(detectPrimaryEvidenceIntegrityViolation({
      experimentMode: "real_execution",
      runnerSource
    })).toContain("cannot satisfy governed experiment completion");
  });

  it("blocks completed metrics carrying non-evidence provenance", () => {
    const metricsText = JSON.stringify({
      status: "completed",
      evidence_class: "codex_mock",
      aggregate_results: [{ condition: "candidate_condition", score: 0.7 }]
    });

    expect(detectPrimaryEvidenceIntegrityViolation({
      experimentMode: "real_execution",
      metricsText
    })).toContain("generated metrics");
  });

  it("allows failed diagnostic output and genuine real-execution output", () => {
    expect(detectPrimaryEvidenceIntegrityViolation({
      experimentMode: "real_execution",
      runnerSource: "diagnostic_only = True\npayload = {'status': 'failed', 'synthetic': True}",
      metricsText: JSON.stringify({ status: "blocked", synthetic: true })
    })).toBeUndefined();

    expect(detectPrimaryEvidenceIntegrityViolation({
      experimentMode: "real_execution",
      runnerSource: "def main():\n    return execute_measurement()",
      metricsText: JSON.stringify({
        status: "completed",
        execution_mode: "real_execution",
        aggregate_results: [{ condition: "baseline_condition", score: 0.6 }]
      })
    })).toBeUndefined();
  });

  it("does not gate non-promoting validation mode", () => {
    expect(detectPrimaryEvidenceIntegrityViolation({
      experimentMode: "synthetic_validation",
      runnerSource: "fallback_metrics = {'status': 'completed'}"
    })).toBeUndefined();
  });

  it("does not mutate the inspected inputs", () => {
    const input = Object.freeze({
      experimentMode: "real_execution",
      runnerSource: "def main():\n    return execute_measurement()",
      metricsText: JSON.stringify({ status: "completed", execution_mode: "real_execution" })
    });
    const before = JSON.stringify(input);

    detectPrimaryEvidenceIntegrityViolation(input);

    expect(JSON.stringify(input)).toBe(before);
  });
});
