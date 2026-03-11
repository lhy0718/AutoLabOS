import { describe, expect, it } from "vitest";

import {
  buildHeuristicObjectiveMetricProfile,
  evaluateObjectiveMetric
} from "../src/core/objectiveMetric.js";

describe("objectiveMetric", () => {
  it("derives thresholded accuracy objectives heuristically", () => {
    const profile = buildHeuristicObjectiveMetricProfile("accuracy at least 0.9");

    expect(profile.primaryMetric).toBe("accuracy");
    expect(profile.preferredMetricKeys).toContain("accuracy");
    expect(profile.direction).toBe("maximize");
    expect(profile.comparator).toBe(">=");
    expect(profile.targetValue).toBe(0.9);
  });

  it("evaluates observed metrics against the resolved profile", () => {
    const profile = buildHeuristicObjectiveMetricProfile("latency under 200");
    const evaluation = evaluateObjectiveMetric(
      {
        latency_ms: 180,
        accuracy: 0.92
      },
      profile,
      "latency under 200"
    );

    expect(evaluation.status).toBe("met");
    expect(evaluation.matchedMetricKey).toBe("latency_ms");
    expect(evaluation.summary).toContain("latency_ms=180");
    expect(evaluation.summary).toContain("< 200");
  });

  it("reports missing metrics when the preferred key is absent", () => {
    const profile = buildHeuristicObjectiveMetricProfile("f1 at least 0.8");
    const evaluation = evaluateObjectiveMetric(
      {
        accuracy: 0.91
      },
      profile,
      "f1 at least 0.8"
    );

    expect(evaluation.status).toBe("missing");
    expect(evaluation.summary).toContain("was not found");
  });

  it("infers the sole numeric metric when the objective is otherwise generic", () => {
    const profile = buildHeuristicObjectiveMetricProfile("overall improvement");
    const evaluation = evaluateObjectiveMetric(
      {
        accuracy: 0.91
      },
      profile,
      "overall improvement"
    );

    expect(evaluation.status).toBe("observed");
    expect(evaluation.matchedMetricKey).toBe("accuracy");
    expect(evaluation.summary).toContain('sole numeric metric "accuracy"');
  });
});
