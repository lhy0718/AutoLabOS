import { describe, expect, it } from "vitest";

import {
  sanitizePaperNarrativeText,
  type PaperDraft
} from "../src/core/analysis/paperWriting.js";
import {
  buildFallbackPaperManuscript,
  buildPaperSubmissionValidation,
  parsePaperManuscriptJson,
  renderSubmissionPaperTex,
  stabilizePaperManuscriptForSubmission,
  type PaperManuscript,
  type PaperTraceabilityReport
} from "../src/core/analysis/paperManuscript.js";
import type {
  ResultsArtifactV2,
  ResultsPlanV2,
  ResultsTableDirection
} from "../src/core/analysis/resultsTableSchema.js";
import type { ParsedLatexTemplate } from "../src/core/latex/latexTemplateLoader.js";

interface ContractFixtureOptions {
  direction?: ResultsTableDirection;
  subjectValue?: number;
  referenceValue?: number;
  subjectLabel?: string;
  referenceLabel?: string;
  metricLabel?: string;
  includeAuxiliary?: boolean;
  includePrimaryId?: boolean;
}

function makeContractFixture(
  options: ContractFixtureOptions = {}
): { artifact: ResultsArtifactV2; plan: ResultsPlanV2 } {
  const direction = options.direction ?? "higher_better";
  const subjectValue = options.subjectValue ?? 0.42;
  const referenceValue = options.referenceValue ?? 0.57;
  const metric = {
    id: "metric_q",
    label: options.metricLabel ?? "Measure Q",
    direction,
    unit: "units"
  } as const;
  const subject = {
    id: "series_u",
    label: options.subjectLabel ?? "Series U",
    role: "primary" as const,
    dimensions: { family: "group_u" }
  };
  const reference = {
    id: "series_v",
    label: options.referenceLabel ?? "Series V",
    role: "baseline" as const,
    dimensions: { family: "group_v" }
  };
  const scope = { partition: "slice_q" };
  const subjectObservation = {
    id: "observation_u",
    series_id: subject.id,
    metric_id: metric.id,
    scope,
    value: subjectValue,
    evidence_refs: ["evidence_u"]
  };
  const referenceObservation = {
    id: "observation_v",
    series_id: reference.id,
    metric_id: metric.id,
    scope,
    value: referenceValue,
    evidence_refs: ["evidence_v"]
  };
  const primaryComparison = {
    id: "comparison_main",
    subject_observation_id: subjectObservation.id,
    reference_observation_id: referenceObservation.id,
    delta: subjectValue - referenceValue,
    evidence_refs: ["evidence_u", "evidence_v"]
  };

  const artifact: ResultsArtifactV2 = {
    schema_version: "2.0",
    metrics: [metric],
    series: [subject, reference],
    observations: [subjectObservation, referenceObservation],
    comparisons: [primaryComparison]
  };
  const requiredComparisons = [
    {
      id: primaryComparison.id,
      subject_series_id: subject.id,
      reference_series_id: reference.id,
      metric_id: metric.id,
      scope
    }
  ];

  if (options.includeAuxiliary) {
    const auxiliaryScope = { partition: "slice_r" };
    artifact.observations.push(
      {
        id: "observation_u_aux",
        series_id: subject.id,
        metric_id: metric.id,
        scope: auxiliaryScope,
        value: 91
      },
      {
        id: "observation_v_aux",
        series_id: reference.id,
        metric_id: metric.id,
        scope: auxiliaryScope,
        value: -37
      }
    );
    artifact.comparisons.push({
      id: "comparison_aux",
      subject_observation_id: "observation_u_aux",
      reference_observation_id: "observation_v_aux",
      delta: 128
    });
    requiredComparisons.push({
      id: "comparison_aux",
      subject_series_id: subject.id,
      reference_series_id: reference.id,
      metric_id: metric.id,
      scope: auxiliaryScope
    });
  }

  const plan: ResultsPlanV2 = {
    schema_version: "2.0",
    required_metrics: [{ ...metric }],
    minimum_series_count: 2,
    minimum_comparison_count: options.includeAuxiliary ? 2 : 1,
    required_series: [
      { id: subject.id, role: subject.role },
      { id: reference.id, role: reference.role }
    ],
    required_comparisons: requiredComparisons,
    ...(options.includePrimaryId === false
      ? {}
      : { primary_comparison_id: primaryComparison.id })
  };

  return { artifact, plan };
}

function makeManuscript(overrides: Partial<PaperManuscript> = {}): PaperManuscript {
  return {
    title: "Protocol Q",
    abstract:
      "We report a bounded evaluation. Series V scored 0.57 while Series U scored 0.42.",
    keywords: ["protocol q", "measure q"],
    sections: [
      {
        heading: "Method",
        paragraphs: ["The measurement procedure was fixed before execution."]
      },
      {
        heading: "Results",
        paragraphs: [
          "The evaluation completed as scheduled.",
          "Series U was higher than Series V in the reported result."
        ]
      },
      {
        heading: "Conclusion",
        paragraphs: ["Series U outperformed Series V in this evaluation."]
      }
    ],
    tables: [
      {
        caption: "Unverified comparison.",
        rows: [
          { label: "Series U", value: 0.42 },
          { label: "Series V", value: 0.57 }
        ]
      }
    ],
    figures: [
      {
        caption: "Unverified comparison.",
        bars: [
          { label: "Series U", value: 0.42 },
          { label: "Series V", value: 0.57 }
        ]
      }
    ],
    appendix_sections: [
      {
        heading: "Supplementary Results",
        paragraphs: ["Series U improved relative to Series V."]
      }
    ],
    ...overrides
  };
}

function makeTraceability(
  citationPaperIds: string[] = []
): PaperTraceabilityReport {
  return {
    paragraphs: [
      {
        manuscript_section: "Related Work",
        paragraph_index: 0,
        source_draft_section: "Related Work",
        evidence_ids: [],
        citation_paper_ids: citationPaperIds
      }
    ]
  };
}

function makeParsedTemplate(packageLine: string): ParsedLatexTemplate {
  return {
    sourcePath: "/tmp/template-q.tex",
    documentClass: "\\documentclass[11pt]{article}",
    preamble: packageLine,
    columnLayout: 2,
    packages: [packageLine],
    sectionOrder: ["Introduction", "Related Work", "Method", "Results", "Conclusion"],
    customCommands: [],
    bibliographyStyle: null
  };
}

function renderedResultText(manuscript: PaperManuscript): string {
  return manuscript.sections
    .filter((section) => section.heading === "Results")
    .flatMap((section) => section.paragraphs)
    .join(" ");
}

describe("paper submission sanitization", () => {
  it("cleans duplicated brief-derived phrasing without domain-specific substitutions", () => {
    const text = sanitizePaperNarrativeText(
      "This study addresses Study how protocol Q remains stable. This paper studies Study how protocol Q remains stable. under an explicitly bounded evidence ceiling."
    );

    expect(text).toContain("This study addresses how protocol Q remains stable");
    expect(text).toContain("This paper studies how protocol Q remains stable");
    expect(text).not.toContain("addresses Study how");
    expect(text).not.toContain("studies Study how");
  });

  it("parses a wrapped manuscript envelope", () => {
    const parsed = parsePaperManuscriptJson(JSON.stringify({
      revised_manuscript: {
        title: "Protocol Q",
        abstract: "A bounded report.",
        keywords: ["protocol q"],
        sections: [
          {
            heading: "Results",
            paragraphs: ["A non-directional observation was recorded."]
          }
        ]
      }
    }));

    expect(parsed.title).toBe("Protocol Q");
    expect(parsed.sections?.[0]?.heading).toBe("Results");
  });

  it("renders generic visual rows without a domain-specific wide-table branch", () => {
    const tex = renderSubmissionPaperTex({
      manuscript: makeManuscript({
        abstract: "A bounded report.",
        sections: [{ heading: "Results", paragraphs: ["A measurement was recorded."] }],
        tables: [
          {
            caption: "Measurements for two named series.",
            rows: [
              { label: "Series U", value: 0.42 },
              { label: "Series V", value: 0.57 }
            ]
          }
        ],
        figures: []
      }),
      traceability: { paragraphs: [] },
      citationKeysByPaperId: new Map()
    });

    expect(tex).toContain("Metric & Value");
    expect(tex).toContain("Series U & 0.42");
    expect(tex).not.toContain("\\begin{table*}");
  });

  it("preserves citation ordering with the current ACL template", () => {
    const manuscript = makeManuscript({
      abstract: "A bounded report.",
      sections: [
        {
          heading: "Related Work",
          paragraphs: ["Prior work defines the measurement protocol."]
        }
      ],
      tables: [],
      figures: [],
      appendix_sections: []
    });
    const tex = renderSubmissionPaperTex({
      manuscript,
      traceability: makeTraceability(["paper_z", "paper_a"]),
      citationKeysByPaperId: new Map([
        ["paper_z", "zeta2025"],
        ["paper_a", "alpha2024"]
      ]),
      parsedTemplate: makeParsedTemplate("\\usepackage{acl}"),
      includeKeywords: false
    });

    expect(tex).toContain("\\cite{alpha2024,zeta2025}");
    expect(tex).not.toContain("\\bibliographystyle{");
  });

  it("lets the current ACL package own its bibliography style", () => {
    const tex = renderSubmissionPaperTex({
      manuscript: makeManuscript({
        abstract: "A bounded report.",
        sections: [{ heading: "Introduction", paragraphs: ["A protocol is introduced."] }],
        tables: [],
        figures: [],
        appendix_sections: []
      }),
      traceability: { paragraphs: [] },
      citationKeysByPaperId: new Map(),
      parsedTemplate: makeParsedTemplate("\\usepackage{acl}"),
      includeKeywords: false
    });

    expect(tex).not.toContain("\\bibliographystyle{");
    expect(tex).toContain("\\bibliography{references}");
  });

  it("reports raw evidence identifiers and internal absolute paths", () => {
    const manuscript = makeManuscript({
      abstract: "The record ev_q7 was read from /tmp/run-q/report.json.",
      sections: [{ heading: "Results", paragraphs: ["A bounded observation was recorded."] }],
      tables: [],
      figures: [],
      appendix_sections: []
    });
    const validation = buildPaperSubmissionValidation({
      manuscript,
      tex: "",
      traceability: { paragraphs: [] },
      citationKeysByPaperId: new Map()
    });

    expect(validation.issues.map((issue) => issue.kind)).toContain("evidence_id");
    expect(validation.issues.map((issue) => issue.kind)).toContain("absolute_path");
  });
});

describe("explicit ResultsArtifactV2 primary comparison contract", () => {
  it("renders only the explicitly linked subject and reference observations", () => {
    const { artifact, plan } = makeContractFixture({
      includeAuxiliary: true,
      subjectValue: 0.42,
      referenceValue: 0.57
    });
    artifact.comparisons.reverse();
    artifact.observations.reverse();
    artifact.series.reverse();
    plan.required_comparisons?.reverse();
    plan.required_series?.reverse();

    const stabilized = stabilizePaperManuscriptForSubmission(makeManuscript(), {
      resultsArtifact: artifact,
      resultsPlan: plan
    });
    const resultText = renderedResultText(stabilized);

    expect(resultText).toContain(
      "For Measure Q under Partition=slice_q, Series U (primary role) recorded 0.42 units, while Series V (baseline role) recorded 0.57 units"
    );
    expect(resultText).toContain("declared subject-minus-reference difference was -0.15 units");
    expect(resultText).not.toContain("91");
    expect(resultText).not.toContain("-37");
    expect(stabilized.tables).toHaveLength(1);
    expect(stabilized.figures).toHaveLength(1);
    expect(stabilized.tables?.[0]?.rows.map((row) => row.comparison_side)).toEqual([
      "subject",
      "reference",
      "difference"
    ]);
    expect(stabilized.tables?.[0]?.rows[0]?.series_id).toBe("series_u");
    expect(stabilized.tables?.[0]?.rows[1]?.series_id).toBe("series_v");
    expect(stabilized.tables?.[0]?.rows[0]?.scope_signature).toBe("Partition=slice_q");
    expect(stabilized.tables?.[0]?.source_refs?.map((ref) => ref.id)).toEqual(
      expect.arrayContaining([
        "results_artifact.observation:observation_u",
        "results_artifact.observation:observation_v"
      ])
    );
  });

  it("is invariant to artifact and plan array order", () => {
    const original = makeContractFixture({ includeAuxiliary: true });
    const reordered = structuredClone(original);
    reordered.artifact.metrics.reverse();
    reordered.artifact.series.reverse();
    reordered.artifact.observations.reverse();
    reordered.artifact.comparisons.reverse();
    reordered.plan.required_metrics.reverse();
    reordered.plan.required_series?.reverse();
    reordered.plan.required_comparisons?.reverse();

    const left = stabilizePaperManuscriptForSubmission(makeManuscript(), {
      resultsArtifact: original.artifact,
      resultsPlan: original.plan
    });
    const right = stabilizePaperManuscriptForSubmission(makeManuscript(), {
      resultsArtifact: reordered.artifact,
      resultsPlan: reordered.plan
    });

    expect(right.abstract).toBe(left.abstract);
    expect(right.sections).toEqual(left.sections);
    expect(right.tables).toEqual(left.tables);
    expect(right.figures).toEqual(left.figures);
  });

  it("accepts reorder-equivalent embedded artifact projections", () => {
    const { artifact, plan } = makeContractFixture({ includeAuxiliary: true });
    const projectedArtifact = structuredClone(artifact);
    projectedArtifact.series.reverse();
    projectedArtifact.observations.reverse();
    projectedArtifact.comparisons.reverse();

    const stabilized = stabilizePaperManuscriptForSubmission(makeManuscript(), {
      resultAnalysis: {
        results_artifact: artifact,
        metrics: {
          results_artifact: projectedArtifact,
          results_plan: plan
        }
      } as any
    });

    expect(stabilized.tables).toHaveLength(1);
    expect(stabilized.figures).toHaveLength(1);
    expect(stabilized.tables?.[0]?.rows[0]?.series_id).toBe("series_u");
    expect(stabilized.tables?.[0]?.rows[1]?.series_id).toBe("series_v");
  });

  it("uses opaque labels without assigning roles from names or observed values", () => {
    const { artifact, plan } = makeContractFixture({
      subjectLabel: "Unit Kappa",
      referenceLabel: "Unit Lambda",
      metricLabel: "Measure Tau",
      subjectValue: -4,
      referenceValue: 12
    });

    const stabilized = stabilizePaperManuscriptForSubmission(makeManuscript(), {
      resultsArtifact: artifact,
      resultsPlan: plan
    });
    const rows = stabilized.tables?.[0]?.rows ?? [];

    expect(renderedResultText(stabilized)).toContain(
      "Unit Kappa (primary role) recorded -4 units, while Unit Lambda (baseline role) recorded 12 units"
    );
    expect(rows[0]?.series_id).toBe("series_u");
    expect(rows[0]?.comparison_side).toBe("subject");
    expect(rows[1]?.series_id).toBe("series_v");
    expect(rows[1]?.comparison_side).toBe("reference");
  });

  it("takes lower-is-better direction only from the explicit metric definition", () => {
    const { artifact, plan } = makeContractFixture({
      direction: "lower_better",
      subjectValue: 1.25,
      referenceValue: 1.75
    });

    const stabilized = stabilizePaperManuscriptForSubmission(makeManuscript(), {
      resultsArtifact: artifact,
      resultsPlan: plan
    });
    const text = JSON.stringify(stabilized);

    expect(text).toContain("lower values preferred by the declared metric definition");
    expect(text).toContain("declared subject-minus-reference difference was -0.5 units");
    expect(text).not.toContain("winner");
  });

  it("fails closed when multiple comparisons have no explicit primary id", () => {
    const { artifact, plan } = makeContractFixture({
      includeAuxiliary: true,
      includePrimaryId: false
    });

    const stabilized = stabilizePaperManuscriptForSubmission(makeManuscript(), {
      resultsArtifact: artifact,
      resultsPlan: plan
    });

    expect(stabilized.tables).toBeUndefined();
    expect(stabilized.figures).toBeUndefined();
    expect(stabilized.abstract).not.toContain("scored");
    expect(renderedResultText(stabilized)).toContain(
      "No directional result is reported because the available evidence does not identify one fully specified primary comparison."
    );
  });

  it("requires an explicit primary id even for one comparison", () => {
    const { artifact, plan } = makeContractFixture({ includePrimaryId: false });

    const stabilized = stabilizePaperManuscriptForSubmission(makeManuscript(), {
      resultsArtifact: artifact,
      resultsPlan: plan
    });

    expect(stabilized.tables).toBeUndefined();
    expect(stabilized.figures).toBeUndefined();
    expect(renderedResultText(stabilized)).toContain("No directional result is reported");
  });

  it("fails closed when the declared difference is inconsistent with observations", () => {
    const { artifact, plan } = makeContractFixture();
    artifact.comparisons[0].delta = 77;

    const stabilized = stabilizePaperManuscriptForSubmission(makeManuscript(), {
      resultsArtifact: artifact,
      resultsPlan: plan
    });

    expect(stabilized.tables).toBeUndefined();
    expect(stabilized.figures).toBeUndefined();
    expect(JSON.stringify(stabilized)).not.toContain("77");
    expect(renderedResultText(stabilized)).toContain("No directional result is reported");
  });

  it("fails closed when the metric definition differs between plan and artifact", () => {
    const { artifact, plan } = makeContractFixture();
    plan.required_metrics[0].label = "Measure R";

    const stabilized = stabilizePaperManuscriptForSubmission(makeManuscript(), {
      resultsArtifact: artifact,
      resultsPlan: plan
    });

    expect(stabilized.tables).toBeUndefined();
    expect(stabilized.figures).toBeUndefined();
    expect(renderedResultText(stabilized)).toContain("No directional result is reported");
  });

  it("fails closed when a linked series has no explicit role", () => {
    const { artifact, plan } = makeContractFixture();
    delete artifact.series[0].role;

    const stabilized = stabilizePaperManuscriptForSubmission(makeManuscript(), {
      resultsArtifact: artifact,
      resultsPlan: plan
    });

    expect(stabilized.tables).toBeUndefined();
    expect(stabilized.figures).toBeUndefined();
    expect(renderedResultText(stabilized)).toContain("No directional result is reported");
  });

  it("fails closed for non-equivalent embedded V2 candidates", () => {
    const first = makeContractFixture();
    const secondArtifact = structuredClone(first.artifact);
    secondArtifact.observations[0].value = 0.9;
    secondArtifact.comparisons[0].delta =
      secondArtifact.observations[0].value - secondArtifact.observations[1].value;

    const stabilized = stabilizePaperManuscriptForSubmission(makeManuscript(), {
      resultAnalysis: {
        results_artifact: first.artifact,
        results_plan: first.plan,
        metrics: {
          results_artifact: secondArtifact,
          results_plan: first.plan
        }
      } as any
    });

    expect(stabilized.tables).toBeUndefined();
    expect(stabilized.figures).toBeUndefined();
    expect(renderedResultText(stabilized)).toContain("No directional result is reported");
  });

  it("keeps fallback manuscripts below the comparison ceiling until a plan is supplied", () => {
    const { artifact } = makeContractFixture();
    const draft = {
      title: "Protocol Q",
      abstract: "Series U outperformed Series V.",
      keywords: ["protocol q"],
      sections: [
        {
          heading: "Results",
          paragraphs: [
            {
              text: "Series U improved relative to Series V.",
              evidence_ids: [],
              citation_paper_ids: []
            }
          ]
        }
      ]
    } as PaperDraft;

    const manuscript = buildFallbackPaperManuscript({
      draft,
      resultAnalysis: { results_artifact: artifact } as any
    });

    expect(manuscript.tables).toBeUndefined();
    expect(manuscript.figures).toBeUndefined();
    expect(manuscript.abstract).not.toContain("outperformed");
    expect(renderedResultText(manuscript)).toContain("No directional result is reported");
  });
});
