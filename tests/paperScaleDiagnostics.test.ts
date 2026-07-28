import { describe, expect, it } from "vitest";

import {
  evaluatePaperScaleDiagnostics,
  type PaperScaleDiagnostic
} from "../src/core/analysis/paperScaleDiagnostics.js";
import type { ResultsArtifactV2 } from "../src/core/analysis/resultsTableSchema.js";
import type {
  AnalysisReport,
  AnalysisStatisticalSummary
} from "../src/core/resultAnalysis.js";

describe("paper-scale diagnostics from explicit V2 evidence", () => {
  it("is invariant to opaque renaming and array reordering without selecting the largest delta", () => {
    const firstArtifact = buildArtifact("qm");
    const firstResult = evaluateArtifact(firstArtifact, buildSummary(firstArtifact), {
      primaryComparisonId: PRIMARY_COMPARISON_IDS.qm
    });

    const renamedArtifact = buildArtifact("vx");
    const reorderedArtifact: ResultsArtifactV2 = {
      ...renamedArtifact,
      metrics: [...renamedArtifact.metrics].reverse(),
      series: [...renamedArtifact.series].reverse(),
      observations: [...renamedArtifact.observations].reverse(),
      comparisons: [...renamedArtifact.comparisons].reverse()
    };
    const reorderedResult = evaluateArtifact(
      reorderedArtifact,
      buildSummary(reorderedArtifact),
      { primaryComparisonId: PRIMARY_COMPARISON_IDS.vx }
    );

    expect(diagnosticFingerprint(firstResult.diagnostics)).toEqual([
      {
        id: "missing_seed_replication",
        severity: "blocking",
        category: "statistical_adequacy"
      },
      {
        id: "single_item_gain",
        severity: "blocking",
        category: "statistical_adequacy"
      }
    ]);
    expect(diagnosticFingerprint(reorderedResult.diagnostics)).toEqual(
      diagnosticFingerprint(firstResult.diagnostics)
    );
    expect(firstResult.diagnostics.find((item) => item.id === "single_item_gain")?.evidence)
      .toContain("delta 0.01");
  });

  it("uses explicit lower-better direction instead of treating a positive delta as improvement", () => {
    const improvedArtifact = buildArtifact("qm");
    const improved = resolvePrimaryFixture(improvedArtifact);
    improved.metric.direction = "lower_better";
    improved.subject.value = 0.44;
    improved.reference.value = 0.45;
    improved.comparison.delta = -0.01;

    const improvedIds = diagnosticIds(
      evaluateArtifact(improvedArtifact, buildSummary(improvedArtifact), {
        primaryComparisonId: PRIMARY_COMPARISON_IDS.qm
      }).diagnostics
    );
    expect(improvedIds).toEqual(
      expect.arrayContaining(["missing_seed_replication", "single_item_gain"])
    );

    const worseArtifact = structuredClone(improvedArtifact);
    const worse = resolvePrimaryFixture(worseArtifact);
    worse.subject.value = 0.46;
    worse.reference.value = 0.45;
    worse.comparison.delta = 0.01;

    const worseIds = diagnosticIds(
      evaluateArtifact(worseArtifact, buildSummary(worseArtifact), {
        primaryComparisonId: PRIMARY_COMPARISON_IDS.qm
      }).diagnostics
    );
    expect(worseIds).not.toContain("missing_seed_replication");
    expect(worseIds).not.toContain("single_item_gain");
  });

  it("fails closed when multiple comparisons have no explicit primary subject", () => {
    const artifact = buildArtifact("qm");
    const summary = buildSummary(artifact);

    const result = evaluateArtifact(artifact, summary);
    const ids = diagnosticIds(result.diagnostics);

    expect(ids).toContain("ambiguous_primary_comparison");
    expect(ids).not.toContain("missing_seed_replication");
    expect(ids).not.toContain("single_item_gain");
    expect(result.diagnostics.find((item) => item.id === "ambiguous_primary_comparison"))
      .toMatchObject({ severity: "blocking", category: "statistical_adequacy" });
  });

  it("rejects an inconsistent explicit delta before deriving a comparative claim", () => {
    const artifact = buildArtifact("qm");
    resolvePrimaryFixture(artifact).comparison.delta = 0.02;

    const result = evaluateArtifact(artifact, buildSummary(artifact), {
      primaryComparisonId: PRIMARY_COMPARISON_IDS.qm
    });
    const ids = diagnosticIds(result.diagnostics);

    expect(ids).toContain("invalid_results_artifact");
    expect(ids).not.toContain("missing_seed_replication");
    expect(ids).not.toContain("single_item_gain");
    expect(result.diagnostics.find((item) => item.id === "invalid_results_artifact")?.evidence)
      .toContain("delta must equal subject value minus reference value");
  });

  it("keeps generic tiny-sample, seed, smoke, and execution-coverage diagnostics", () => {
    const tinyArtifact = buildArtifact("qm");
    const tinyPrimary = resolvePrimaryFixture(tinyArtifact);
    tinyPrimary.subject.value = 0.65;
    tinyPrimary.reference.value = 0.45;
    tinyPrimary.comparison.delta = 0.2;
    const tinyIds = diagnosticIds(evaluateArtifact(
      tinyArtifact,
      buildSummary(tinyArtifact, { sampleSize: 12, seedCount: 3 }),
      { primaryComparisonId: PRIMARY_COMPARISON_IDS.qm }
    ).diagnostics);
    expect(tinyIds).toContain("tiny_eval_sample");
    expect(tinyIds).not.toContain("missing_seed_replication");

    const seedArtifact = buildArtifact("qm");
    const weakSeedIds = diagnosticIds(evaluateArtifact(
      seedArtifact,
      buildSummary(seedArtifact, { sampleSize: 200, seedCount: 1 }),
      { primaryComparisonId: PRIMARY_COMPARISON_IDS.qm }
    ).diagnostics);
    const coveredSeedIds = diagnosticIds(evaluateArtifact(
      seedArtifact,
      buildSummary(seedArtifact, { sampleSize: 200, seedCount: 3 }),
      { primaryComparisonId: PRIMARY_COMPARISON_IDS.qm }
    ).diagnostics);
    expect(weakSeedIds).toContain("missing_seed_replication");
    expect(coveredSeedIds).not.toContain("missing_seed_replication");

    const smokeSummary = buildSummary(seedArtifact, {
      sampleSize: null,
      seedCount: null,
      totalTrials: 1,
      executedTrials: 1
    });
    expect(diagnosticIds(evaluateArtifact(seedArtifact, smokeSummary, {
      primaryComparisonId: PRIMARY_COMPARISON_IDS.qm
    }).diagnostics))
      .toEqual(expect.arrayContaining(["missing_seed_replication", "smoke_only_evidence"]));

    const incompleteSummary = buildSummary(seedArtifact, {
      sampleSize: 200,
      seedCount: 3,
      totalTrials: 5,
      executedTrials: 2
    });
    expect(diagnosticIds(evaluateArtifact(seedArtifact, incompleteSummary, {
      primaryComparisonId: PRIMARY_COMPARISON_IDS.qm
    }).diagnostics))
      .toContain("incomplete_planned_runs");
  });

  it("uses condition-result seed arrays and explicit numeric training budgets", () => {
    const artifact = buildArtifact("qm");
    const summary = buildSummary(artifact, {
      sampleSize: 200,
      seedCount: null,
      totalTrials: 6,
      executedTrials: 2
    });
    const result = evaluateArtifact(artifact, summary, {
      primaryComparisonId: PRIMARY_COMPARISON_IDS.qm,
      metrics: {
        run_config: {
          optimizer_steps: 30,
          max_train_samples: 60,
          planned_max_train_samples: 600
        },
        condition_results: [
          { seeds: [101, 102, 103], seed_count: 3 },
          { seeds: [101, 102, 103], seed_count: 3 }
        ]
      }
    });
    const ids = diagnosticIds(result.diagnostics);

    expect(ids).not.toContain("missing_seed_replication");
    expect(ids).toEqual(
      expect.arrayContaining(["incomplete_planned_runs", "training_budget_mismatch"])
    );
  });
});

type FixtureVariant = "qm" | "vx";

const PRIMARY_COMPARISON_IDS: Record<FixtureVariant, string> = {
  qm: "c-lm",
  vx: "c-pu"
};

function buildArtifact(variant: FixtureVariant): ResultsArtifactV2 {
  const ids = variant === "qm"
    ? {
      metric: "m-qx",
      extraMetric: "m-rj",
      primarySeries: "s-vp",
      referenceSeries: "s-kt",
      extraSeries: "s-nw",
      primaryObservation: "o-pa",
      referenceObservation: "o-rb",
      extraObservation: "o-xc",
      auxiliaryObservation: "o-yd",
      primaryComparison: "c-lm",
      auxiliaryComparison: "c-az",
      labels: ["Series Quill", "Series Vale", "Series Wren"]
    }
    : {
      metric: "m-uf",
      extraMetric: "m-dk",
      primarySeries: "s-hz",
      referenceSeries: "s-bg",
      extraSeries: "s-rc",
      primaryObservation: "o-je",
      referenceObservation: "o-tn",
      extraObservation: "o-wf",
      auxiliaryObservation: "o-gs",
      primaryComparison: "c-pu",
      auxiliaryComparison: "c-ex",
      labels: ["Series Umber", "Series Grove", "Series Firth"]
    };

  return {
    schema_version: "2.0",
    metrics: [
      {
        id: ids.metric,
        label: "Measure Delta",
        direction: "higher_better",
        unit: "ratio"
      },
      {
        id: ids.extraMetric,
        label: "Measure Sigma",
        direction: "lower_better",
        unit: "units"
      }
    ],
    series: [
      {
        id: ids.primarySeries,
        label: ids.labels[0],
        role: "primary",
        dimensions: { cohort: "quartz" }
      },
      {
        id: ids.referenceSeries,
        label: ids.labels[1],
        role: "baseline",
        dimensions: { cohort: "quartz" }
      },
      {
        id: ids.extraSeries,
        label: ids.labels[2],
        role: "comparator",
        dimensions: { cohort: "quartz" }
      }
    ],
    observations: [
      {
        id: ids.primaryObservation,
        series_id: ids.primarySeries,
        metric_id: ids.metric,
        scope: { slice: "opal" },
        value: 0.46
      },
      {
        id: ids.referenceObservation,
        series_id: ids.referenceSeries,
        metric_id: ids.metric,
        scope: { slice: "opal" },
        value: 0.45
      },
      {
        id: ids.extraObservation,
        series_id: ids.extraSeries,
        metric_id: ids.metric,
        scope: { slice: "opal" },
        value: 0.95
      },
      {
        id: ids.auxiliaryObservation,
        series_id: ids.extraSeries,
        metric_id: ids.extraMetric,
        scope: { slice: "opal" },
        value: 7
      }
    ],
    comparisons: [
      {
        id: ids.auxiliaryComparison,
        subject_observation_id: ids.extraObservation,
        reference_observation_id: ids.referenceObservation,
        delta: 0.5
      },
      {
        id: ids.primaryComparison,
        subject_observation_id: ids.primaryObservation,
        reference_observation_id: ids.referenceObservation,
        delta: 0.01
      }
    ]
  };
}

function buildSummary(
  artifact: ResultsArtifactV2,
  options: {
    sampleSize?: number | null;
    seedCount?: number | null;
    totalTrials?: number;
    executedTrials?: number;
  } = {}
): AnalysisStatisticalSummary {
  const primary = resolvePrimaryFixture(artifact);
  const sampleSize = options.sampleSize === undefined ? 100 : options.sampleSize;
  const seedCount = options.seedCount === undefined ? 1 : options.seedCount;
  return {
    total_trials: options.totalTrials ?? 3,
    executed_trials: options.executedTrials ?? 3,
    cached_trials: 0,
    confidence_intervals: sampleSize === null
      ? []
      : [{
        metric_key: primary.metric.id,
        label: "Structured interval",
        lower: 0,
        upper: 1,
        level: 0.95,
        sample_size: sampleSize,
        source: "metrics",
        summary: "Structured interval evidence."
      }],
    stability_metrics: seedCount === null
      ? []
      : [{ key: "evidence.distinct_seed_count", value: seedCount }],
    effect_estimates: artifact.comparisons.map((comparison) => {
      const subject = artifact.observations.find(
        (observation) => observation.id === comparison.subject_observation_id
      );
      const metric = artifact.metrics.find((item) => item.id === subject?.metric_id);
      if (!subject || !metric) throw new Error("fixture comparison references are required");
      const improves = metric.direction === "lower_better"
        ? comparison.delta < 0
        : comparison.delta > 0;
      return {
        comparison_id: comparison.id,
        metric_key: metric.id,
        delta: comparison.delta,
        direction: comparison.delta === 0 ? "neutral" : improves ? "positive" : "negative",
        summary: "Structured effect evidence."
      };
    }),
    notes: []
  };
}

function resolvePrimaryFixture(artifact: ResultsArtifactV2): {
  metric: ResultsArtifactV2["metrics"][number];
  subject: ResultsArtifactV2["observations"][number];
  reference: ResultsArtifactV2["observations"][number];
  comparison: ResultsArtifactV2["comparisons"][number];
} {
  const primarySeries = artifact.series.find((series) => series.role === "primary");
  const subject = artifact.observations.find(
    (observation) => observation.series_id === primarySeries?.id
  );
  const comparison = artifact.comparisons.find(
    (item) => item.subject_observation_id === subject?.id
  );
  const reference = artifact.observations.find(
    (observation) => observation.id === comparison?.reference_observation_id
  );
  const metric = artifact.metrics.find((item) => item.id === subject?.metric_id);
  if (!primarySeries || !subject || !comparison || !reference || !metric) {
    throw new Error("fixture primary comparison is required");
  }
  return { metric, subject, reference, comparison };
}

function evaluateArtifact(
  artifact: ResultsArtifactV2,
  statisticalSummary: AnalysisStatisticalSummary,
  options: {
    primaryComparisonId?: string;
    metrics?: Record<string, unknown>;
  } = {}
) {
  return evaluatePaperScaleDiagnostics({
    report: {
      metrics: options.metrics ?? {},
      results_artifact: artifact,
      ...(options.primaryComparisonId
        ? { primary_comparison_id: options.primaryComparisonId }
        : {}),
      statistical_summary: statisticalSummary
    } as unknown as AnalysisReport,
    topic: "Opaque comparative study",
    bibliographyText: ""
  });
}

function diagnosticIds(diagnostics: PaperScaleDiagnostic[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.id);
}

function diagnosticFingerprint(diagnostics: PaperScaleDiagnostic[]) {
  return diagnostics
    .map((diagnostic) => ({
      id: diagnostic.id,
      severity: diagnostic.severity,
      category: diagnostic.category
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}
