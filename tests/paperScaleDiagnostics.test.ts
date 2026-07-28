import { describe, expect, it } from "vitest";

import {
  assessEvidenceAdequacy,
  buildEvidenceAdequacyContract,
  buildEvidenceAdequacyExecutionReceipt,
  type EvidenceAdequacyAssessmentV2
} from "../src/core/analysis/evidenceAdequacy.js";
import {
  evaluatePaperScaleDiagnostics,
  type PaperScaleDiagnostic
} from "../src/core/analysis/paperScaleDiagnostics.js";
import type { ResultsArtifactV2 } from "../src/core/analysis/resultsTableSchema.js";
import { hashCanonical } from "../src/core/canonicalHash.js";
import type {
  AnalysisReport,
  AnalysisStatisticalSummary
} from "../src/core/resultAnalysis.js";

describe("paper-scale diagnostics with governed evidence adequacy", () => {
  it("accepts a valid pass assessment", () => {
    const artifact = buildArtifact();
    const result = evaluateArtifact(artifact);

    expect(diagnosticIds(result.diagnostics)).not.toEqual(
      expect.arrayContaining([
        "evidence_adequacy_unverified",
        "evidence_adequacy_invalid",
        "evidence_adequacy_not_passed"
      ])
    );
    expect(result.blocking_count).toBe(0);
  });

  it("fails closed as unverified when the assessment is missing", () => {
    const result = evaluateArtifact(buildArtifact(), {
      omitAssessment: true
    });
    const diagnostic = result.diagnostics.find(
      (item) => item.id === "evidence_adequacy_unverified"
    );

    expect(diagnostic).toMatchObject({
      severity: "blocking",
      category: "statistical_adequacy"
    });
    expect(diagnostic?.evidence).toContain("Ungoverned evidence summaries");
  });

  it.each(["unknown", "fail"] as const)(
    "blocks an assessment whose overall status is %s",
    (status) => {
      const artifact = buildArtifact();
      const result = evaluateArtifact(artifact, {
        assessment: buildAssessment(PRIMARY_COMPARISON_ID, status)
      });
      const diagnostic = result.diagnostics.find(
        (item) => item.id === "evidence_adequacy_not_passed"
      );

      expect(diagnostic).toMatchObject({ severity: "blocking" });
      expect(diagnostic?.evidence).toContain(`overall_status=${status}`);
      expect(diagnostic?.evidence).toContain(
        status === "unknown" ? "uncertainty=unknown" : "denominator_coverage=fail"
      );
    }
  );

  it("accepts deterministic exhaustive evidence without seed or optimizer metadata", () => {
    const artifact = buildArtifact();
    const result = evaluateArtifact(artifact, {
      metrics: {},
      summary: buildSummary(artifact, { totalTrials: 1, executedTrials: 1 })
    });

    expect(result.blocking_count).toBe(0);
    expect(diagnosticIds(result.diagnostics)).not.toContain(
      "evidence_adequacy_not_passed"
    );
  });

  it("does not accept a raw effect estimate when no assessment exists", () => {
    const artifact = buildArtifact();
    const summary = buildSummary(artifact, { includeRawEffect: true });
    const result = evaluateArtifact(artifact, {
      omitAssessment: true,
      summary
    });

    expect(summary.effect_estimates).toHaveLength(1);
    expect(diagnosticIds(result.diagnostics)).toContain(
      "evidence_adequacy_unverified"
    );
  });

  it("keeps adequacy invariant across positive, negative, and zero deltas", () => {
    const assessment = buildAssessment(PRIMARY_COMPARISON_ID, "pass");
    const diagnosticSets = [0.1, -0.1, 0].map((delta) => {
      const artifact = buildArtifact();
      setPrimaryDelta(artifact, delta);
      return diagnosticFingerprint(evaluateArtifact(artifact, {
        assessment
      }).diagnostics);
    });

    expect(diagnosticSets[0]).toEqual(diagnosticSets[1]);
    expect(diagnosticSets[1]).toEqual(diagnosticSets[2]);
    expect(diagnosticSets[0]).toEqual([]);
  });

  it("retains ResultsArtifactV2 integrity validation", () => {
    const artifact = buildArtifact();
    artifact.comparisons[0].delta = 0.25;

    const result = evaluateArtifact(artifact);

    expect(diagnosticIds(result.diagnostics)).toContain(
      "invalid_results_artifact"
    );
    expect(result.diagnostics.find(
      (item) => item.id === "invalid_results_artifact"
    )?.evidence).toContain("delta must equal subject value minus reference value");
  });

  it("retains exact primary-comparison selection", () => {
    const result = evaluateArtifact(buildArtifact(), {
      omitPrimaryComparison: true
    });

    expect(diagnosticIds(result.diagnostics)).toContain(
      "ambiguous_primary_comparison"
    );
  });

  it("blocks an assessment bound to a different report primary", () => {
    const result = evaluateArtifact(buildArtifact(), {
      assessment: buildAssessment("comparison-other", "pass")
    });

    expect(diagnosticIds(result.diagnostics)).toContain(
      "evidence_adequacy_primary_mismatch"
    );
  });
});

const PRIMARY_COMPARISON_ID = "comparison-quality";

function buildArtifact(): ResultsArtifactV2 {
  return {
    schema_version: "2.0",
    metrics: [
      {
        id: "metric-quality",
        label: "Outcome quality",
        direction: "higher_better",
        unit: "unitless"
      }
    ],
    series: [
      {
        id: "series-reference",
        label: "Reference series",
        role: "baseline",
        dimensions: { partition: "evaluation" }
      },
      {
        id: "series-subject",
        label: "Subject series",
        role: "primary",
        dimensions: { partition: "evaluation" }
      }
    ],
    observations: [
      {
        id: "observation-reference",
        series_id: "series-reference",
        metric_id: "metric-quality",
        scope: { partition: "evaluation" },
        value: 0.5
      },
      {
        id: "observation-subject",
        series_id: "series-subject",
        metric_id: "metric-quality",
        scope: { partition: "evaluation" },
        value: 0.6
      }
    ],
    comparisons: [
      {
        id: PRIMARY_COMPARISON_ID,
        subject_observation_id: "observation-subject",
        reference_observation_id: "observation-reference",
        delta: 0.1
      }
    ]
  };
}

function buildSummary(
  artifact: ResultsArtifactV2,
  options: {
    totalTrials?: number;
    executedTrials?: number;
    includeRawEffect?: boolean;
  } = {}
): AnalysisStatisticalSummary {
  return {
    total_trials: options.totalTrials ?? 1,
    executed_trials: options.executedTrials ?? 1,
    cached_trials: 0,
    confidence_intervals: [],
    stability_metrics: [],
    effect_estimates: options.includeRawEffect
      ? [{
        comparison_id: PRIMARY_COMPARISON_ID,
        metric_key: "metric-quality",
        delta: artifact.comparisons[0].delta,
        direction: artifact.comparisons[0].delta === 0
          ? "neutral"
          : artifact.comparisons[0].delta > 0
            ? "positive"
            : "negative",
        summary: "Raw effect only."
      }]
      : [],
    notes: []
  };
}

function buildAssessment(
  primaryComparisonId: string,
  status: "pass" | "unknown" | "fail"
): EvidenceAdequacyAssessmentV2 {
  if (status === "pass") {
    const populationManifestSha256 = hashCanonical({
      independent_unit_ids: ["unit-a", "unit-b"]
    });
    const contract = buildEvidenceAdequacyContract({
      primaryComparisonId,
      designSource: {
        kind: "deterministic_exhaustive_manifest",
        contentSha256: populationManifestSha256
      },
      independentUnit: {
        key: "fixture identity",
        analysisUnit: "fixture outcome"
      },
      plannedIndependentCoverage: {
        mode: "deterministic_exhaustive",
        targetUniqueUnits: 2,
        targetDenominatorPerArm: 2,
        populationManifestSha256
      },
      requiredContrast: {
        arms: ["reference", "subject"],
        paired: false,
        requiredCompletePairs: null
      },
      uncertaintyRequirement: {
        mode: "none",
        deterministicExhaustiveRationale:
          "Every declared unit is evaluated by a deterministic oracle."
      },
      effectResolution: {
        scale: "proportion",
        minimumResolvableEffect: 0.5
      },
      executionBudget: {
        applicable: false,
        notApplicableRationale:
          "The exhaustive evaluation has no iterative budget floor."
      }
    });
    const receipt = buildEvidenceAdequacyExecutionReceipt({
      contractSha256: contract.content_sha256,
      primaryComparisonId,
      observedPopulationManifestSha256: populationManifestSha256,
      uniqueExecutionIds: ["execution-a", "execution-b"],
      observedIndependentUnitIds: ["unit-a", "unit-b"],
      observedDenominatorByArm: { reference: 2, subject: 2 },
      primaryEvidenceRefs: [
        "artifact://primary-ledger",
        "artifact://deterministic-oracle"
      ],
      deterministicOracleEvidenceRefs: ["artifact://deterministic-oracle"]
    });
    return assessEvidenceAdequacy({ contract, receipt });
  }

  const contract = buildEvidenceAdequacyContract({
    primaryComparisonId,
    designSource: {
      kind: "estimator_protocol",
      contentSha256: hashCanonical({ design: "sampled-comparison" })
    },
    independentUnit: {
      key: "source identity",
      analysisUnit: "recorded outcome"
    },
    plannedIndependentCoverage: {
      mode: "sampled",
      targetUniqueUnits: 2,
      targetDenominatorPerArm: 2
    },
    requiredContrast: {
      arms: ["reference", "subject"],
      paired: false,
      requiredCompletePairs: null
    },
    uncertaintyRequirement: {
      mode: "required",
      allowedMethods: ["paired-resampling"],
      confidenceLevel: 0.95,
      decisionRule: "directed_interval_bound_meets_effect_criterion"
    },
    effectResolution: {
      scale: "difference",
      minimumResolvableEffect: 0.1
    },
    executionBudget: {
      applicable: false,
      notApplicableRationale:
        "The design declares no separate execution budget floor."
    }
  });
  const receipt = buildEvidenceAdequacyExecutionReceipt({
    contractSha256: contract.content_sha256,
    primaryComparisonId,
    uniqueExecutionIds: ["execution-a", "execution-b"],
    observedIndependentUnitIds: ["unit-a", "unit-b"],
    observedDenominatorByArm: {
      reference: 2,
      subject: status === "fail" ? 1 : 2
    },
    observedUncertaintyMethods:
      status === "unknown" ? [] : ["paired-resampling"],
    primaryEvidenceRefs: ["artifact://primary-ledger"]
  });
  return assessEvidenceAdequacy({ contract, receipt });
}

function setPrimaryDelta(
  artifact: ResultsArtifactV2,
  delta: number
): void {
  const reference = artifact.observations.find(
    (observation) => observation.id === "observation-reference"
  )!;
  const subject = artifact.observations.find(
    (observation) => observation.id === "observation-subject"
  )!;
  reference.value = 0.5;
  subject.value = 0.5 + delta;
  artifact.comparisons[0].delta = delta;
}

function evaluateArtifact(
  artifact: ResultsArtifactV2,
  options: {
    assessment?: EvidenceAdequacyAssessmentV2;
    omitAssessment?: boolean;
    omitPrimaryComparison?: boolean;
    metrics?: Record<string, unknown>;
    summary?: AnalysisStatisticalSummary;
  } = {}
) {
  const report = {
    metrics: options.metrics ?? {},
    results_artifact: artifact,
    ...(!options.omitPrimaryComparison
      ? { primary_comparison_id: PRIMARY_COMPARISON_ID }
      : {}),
    statistical_summary: options.summary ?? buildSummary(artifact),
    ...(!options.omitAssessment
      ? {
        evidence_adequacy_assessment:
          options.assessment ?? buildAssessment(PRIMARY_COMPARISON_ID, "pass")
      }
      : {})
  } as unknown as AnalysisReport;

  return evaluatePaperScaleDiagnostics({
    report,
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
