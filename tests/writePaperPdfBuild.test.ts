import path from "node:path";
import { tmpdir } from "node:os";
import { appendFile, mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { InMemoryEventStream } from "../src/core/events.js";
import { LLMClient, LLMCompleteOptions, MockLLMClient } from "../src/core/llm/client.js";
import { RunContextMemory } from "../src/core/memory/runContextMemory.js";
import { createWritePaperNode, validateCompiledPdfPageBudget } from "../src/core/nodes/writePaper.js";
import {
  DERIVED_MAIN_FIGURE_SOURCE_REF_ID,
  DERIVED_MAIN_TABLE_SOURCE_REF_ID,
  stabilizePaperManuscriptForSubmission,
  type PaperManuscript
} from "../src/core/analysis/paperManuscript.js";
import type {
  ResultsArtifactV2,
  ResultsPlanV2,
  ResultsTableDirection
} from "../src/core/analysis/resultsTableSchema.js";
import {
  buildPublicAnalysisDir,
  buildPublicPaperDir,
  buildPublicRunManifestPath,
  buildPublicRunOutputDir
} from "../src/core/publicArtifacts.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import { RunRecord } from "../src/types.js";

const ORIGINAL_CWD = process.cwd();

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
});

class SequencedLLMClient extends MockLLMClient implements LLMClient {
  private index = 0;

  constructor(private readonly responses: string[]) {
    super();
  }

  override async complete(_prompt: string, _opts?: LLMCompleteOptions): Promise<{ text: string }> {
    const text = this.responses[Math.min(this.index, this.responses.length - 1)] ?? "";
    this.index += 1;
    return { text };
  }
}

const PRIMARY_METRIC_ID = "outcome_score";
const PRIMARY_METRIC_LABEL = "Outcome score";
const PRIMARY_COMPARISON_ID = "comparison-primary-outcome";
const SUBJECT_SERIES_ID = "series-subject";
const REFERENCE_SERIES_ID = "series-reference";
const SUBJECT_OBSERVATION_ID = "observation-subject";
const REFERENCE_OBSERVATION_ID = "observation-reference";
const SUBJECT_SERIES_LABEL = "Evaluated workflow";
const REFERENCE_SERIES_LABEL = "Reference workflow";
const EVALUATION_SCOPE = { partition: "held-out partition" } as const;

interface ResultsContractFixtureOptions {
  metricId?: string;
  metricLabel?: string;
  direction?: ResultsTableDirection;
  unit?: string;
  subjectValue?: number;
  referenceValue?: number;
  subjectLabel?: string;
  referenceLabel?: string;
  includeResourceMetrics?: boolean;
}

function buildResultsContractFixture(
  options: ResultsContractFixtureOptions = {}
): {
  primary_comparison_id: string;
  results_artifact: ResultsArtifactV2;
  results_plan: ResultsPlanV2;
} {
  const metric = {
    id: options.metricId ?? PRIMARY_METRIC_ID,
    label: options.metricLabel ?? PRIMARY_METRIC_LABEL,
    direction: options.direction ?? "higher_better",
    unit: options.unit ?? "points"
  };
  const subjectValue = options.subjectValue ?? 0.76;
  const referenceValue = options.referenceValue ?? 0.71;
  const subjectLabel = options.subjectLabel ?? SUBJECT_SERIES_LABEL;
  const referenceLabel = options.referenceLabel ?? REFERENCE_SERIES_LABEL;
  const resourceMetrics: ResultsArtifactV2["metrics"] = options.includeResourceMetrics
    ? [
        {
          id: "runtime_seconds",
          label: "Runtime",
          direction: "lower_better",
          unit: "seconds"
        },
        {
          id: "peak_memory_mb",
          label: "Peak memory",
          direction: "lower_better",
          unit: "MB"
        }
      ]
    : [];
  const resourceObservations: ResultsArtifactV2["observations"] = options.includeResourceMetrics
    ? [
        {
          id: "observation-subject-runtime",
          series_id: SUBJECT_SERIES_ID,
          metric_id: "runtime_seconds",
          scope: EVALUATION_SCOPE,
          value: 1.05,
          evidence_refs: ["latest_results.json"]
        },
        {
          id: "observation-reference-runtime",
          series_id: REFERENCE_SERIES_ID,
          metric_id: "runtime_seconds",
          scope: EVALUATION_SCOPE,
          value: 1.08,
          evidence_refs: ["latest_results.json"]
        },
        {
          id: "observation-subject-memory",
          series_id: SUBJECT_SERIES_ID,
          metric_id: "peak_memory_mb",
          scope: EVALUATION_SCOPE,
          value: 149,
          evidence_refs: ["latest_results.json"]
        },
        {
          id: "observation-reference-memory",
          series_id: REFERENCE_SERIES_ID,
          metric_id: "peak_memory_mb",
          scope: EVALUATION_SCOPE,
          value: 151,
          evidence_refs: ["latest_results.json"]
        }
      ]
    : [];
  const results_artifact: ResultsArtifactV2 = {
    schema_version: "2.0",
    metrics: [metric, ...resourceMetrics],
    series: [
      {
        id: SUBJECT_SERIES_ID,
        label: subjectLabel,
        role: "primary",
        dimensions: { evaluation_phase: "confirmed" }
      },
      {
        id: REFERENCE_SERIES_ID,
        label: referenceLabel,
        role: "baseline",
        dimensions: { evaluation_phase: "confirmed" }
      }
    ],
    observations: [
      {
        id: SUBJECT_OBSERVATION_ID,
        series_id: SUBJECT_SERIES_ID,
        metric_id: metric.id,
        scope: EVALUATION_SCOPE,
        value: subjectValue,
        evidence_refs: ["result_analysis.json", "latest_results.json"]
      },
      {
        id: REFERENCE_OBSERVATION_ID,
        series_id: REFERENCE_SERIES_ID,
        metric_id: metric.id,
        scope: EVALUATION_SCOPE,
        value: referenceValue,
        evidence_refs: ["result_analysis.json", "latest_results.json"]
      },
      ...resourceObservations
    ],
    comparisons: [
      {
        id: PRIMARY_COMPARISON_ID,
        subject_observation_id: SUBJECT_OBSERVATION_ID,
        reference_observation_id: REFERENCE_OBSERVATION_ID,
        delta: subjectValue - referenceValue,
        evidence_refs: ["result_analysis.json", "latest_results.json"]
      }
    ]
  };
  const results_plan: ResultsPlanV2 = {
    schema_version: "2.0",
    required_metrics: results_artifact.metrics.map((item) => ({ ...item })),
    minimum_series_count: 2,
    minimum_comparison_count: 1,
    required_series: [
      { id: SUBJECT_SERIES_ID, role: "primary" },
      { id: REFERENCE_SERIES_ID, role: "baseline" }
    ],
    required_comparisons: [
      {
        id: PRIMARY_COMPARISON_ID,
        subject_series_id: SUBJECT_SERIES_ID,
        reference_series_id: REFERENCE_SERIES_ID,
        metric_id: metric.id,
        scope: EVALUATION_SCOPE
      }
    ],
    primary_comparison_id: PRIMARY_COMPARISON_ID
  };

  return {
    primary_comparison_id: PRIMARY_COMPARISON_ID,
    results_artifact,
    results_plan
  };
}

function makeRun(runId: string): RunRecord {
  return {
    version: 3,
    workflowVersion: 3,
    id: runId,
    title: "Configured Evaluation Report",
    topic: "configured workflow evaluation",
    constraints: [],
    objectiveMetric: "",
    status: "running",
    currentNode: "write_paper",
    latestSummary: undefined,
    nodeThreads: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    graph: createDefaultGraphState(),
    memoryRefs: {
      runContextPath: `.autolabos/runs/${runId}/memory/run_context.json`,
      longTermPath: `.autolabos/runs/${runId}/memory/long_term.jsonl`,
      episodePath: `.autolabos/runs/${runId}/memory/episodes.jsonl`
    }
  };
}

async function seedRun(root: string, run: RunRecord): Promise<string> {
  const runDir = path.join(root, ".autolabos", "runs", run.id);
  await mkdir(path.join(runDir, "memory"), { recursive: true });
  await writeFile(
    path.join(runDir, "memory", "run_context.json"),
    JSON.stringify({ version: 1, items: [] }),
    "utf8"
  );
  await writeFile(
    path.join(runDir, "paper_summaries.jsonl"),
    `${JSON.stringify({
      paper_id: "paper_1",
      title: "Declared Evaluation Protocol",
      source_type: "full_text",
      summary: "Explicit comparison roles improve result traceability.",
      key_findings: ["Declared subject and reference roles keep comparisons auditable."],
      limitations: [],
      datasets: ["evaluation_suite"],
      metrics: [PRIMARY_METRIC_ID],
      novelty: "Role-bound comparison reporting",
      reproducibility_notes: ["Includes repeated evaluations with explicit evidence links."]
    })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(runDir, "evidence_store.jsonl"),
    `${JSON.stringify({
      evidence_id: "ev_1",
      paper_id: "paper_1",
      claim: "Explicit comparison roles improve result traceability.",
      method_slot: "configured workflow comparison",
      result_slot: "bounded primary outcome difference",
      limitation_slot: "single evaluation suite",
      dataset_slot: "evaluation_suite",
      metric_slot: PRIMARY_METRIC_ID,
      evidence_span: "Repeated evaluations preserved the declared subject and reference links.",
      source_type: "full_text",
      confidence: 0.92,
      confidence_reason: "The evidence comes from one evaluation suite, so external validity remains limited."
    })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(runDir, "hypotheses.jsonl"),
    `${JSON.stringify({
      hypothesis_id: "h_1",
      text: "The evaluated workflow differs from the declared reference on the primary outcome.",
      evidence_links: ["ev_1"]
    })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(runDir, "corpus.jsonl"),
    `${JSON.stringify({
      paper_id: "paper_1",
      title: "Declared Evaluation Protocol",
      abstract: "Explicit comparison roles improve result traceability.",
      authors: ["Alice Doe"],
      year: 2025,
      venue: "ACL"
    })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(runDir, "experiment_plan.yaml"),
    [
      "selected_design:",
      '  title: "Configured workflow comparison"',
      '  summary: "Compare an evaluated workflow with its declared reference under a fixed protocol."',
      "  datasets:",
      '    - "evaluation_suite"',
      "  metrics:",
      `    - "${PRIMARY_METRIC_ID}"`
    ].join("\n"),
    "utf8"
  );
  const resultsContract = buildResultsContractFixture();
  await writeFile(
    path.join(runDir, "result_analysis.json"),
    JSON.stringify(
      {
        analysis_version: 1,
        overview: {
          objective_status: "observed",
          selected_design_title: "Configured workflow comparison"
        },
        execution_summary: {
          observation_count: resultsContract.results_artifact.observations.length
        },
        statistical_summary: {
          notes: ["The declared comparison remained consistent across repeated evaluations."]
        },
        ...resultsContract
      },
      null,
      2
    ),
    "utf8"
  );
  return runDir;
}

function buildSessionResponses(): string[] {
  const outline = JSON.stringify({
    title: "Configured Evaluation Report",
    abstract_focus: ["configured evaluation", "result traceability"],
    section_headings: [
      "Introduction",
      "Related Work",
      "Method",
      "Results",
      "Discussion",
      "Limitations",
      "Conclusion"
    ],
    key_claim_themes: ["The evaluated workflow improves result traceability."],
    citation_plan: ["paper_1"]
  });
  const draft = JSON.stringify({
    title: "Configured Evaluation Report",
    abstract: "A paper-writing workflow with PDF compilation and repair support.",
    keywords: ["configured workflow evaluation", "paper writing"],
    sections: [
      {
        heading: "Introduction",
        paragraphs: [
          "This paper studies PDF-backed drafting for configured workflow evaluation workflows.",
          "This study evaluates whether role-bound result artifacts preserve declared links through the paper-writing workflow.",
          "The contribution is bounded to the inspected evaluation suite and its explicit comparison."
        ],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      },
      {
        heading: "Related Work",
        paragraphs: [
          "Prior work separates result-schema validation, workflow evaluation, and evidence-grounded scientific reporting.",
          "The present study examines how explicit series roles constrain a primary comparison during manuscript production."
        ],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      },
      {
        heading: "Method",
        paragraphs: [
          "The protocol compares Evaluated workflow (primary role) with Reference workflow (baseline role) under the held-out partition before compiling LaTeX.",
          "Both series use the same preprocessing order and fixed selection procedure.",
          "The outcome and resource measurements remain linked to explicit observations."
        ],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      },
      {
        heading: "Results",
        paragraphs: [
          "The declared primary comparison remained traceable across repeated evaluations.",
          "The main table preserves the linked observations for the same role-bound comparison.",
          "The observed difference remains bounded to the declared evaluation scope."
        ],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      },
      {
        heading: "Discussion",
        paragraphs: [
          "The result suggests that explicit comparison semantics can keep quantitative reporting auditable within the tested workflow.",
          "The practical value lies in preserving declared roles, scope, and evidence references across revisions."
        ],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      },
      {
        heading: "Limitations",
        paragraphs: [
          "The evaluation is limited to one configured suite and one declared comparison."
        ],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      },
      {
        heading: "Conclusion",
        paragraphs: ["PDF build feedback turns the writer into a submission-ready agent."],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      }
    ],
    claims: [
      {
        claim_id: "c1",
        statement: "The declared primary comparison remained traceable across repeated evaluations.",
        section_heading: "Results",
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      }
    ]
  });
  const review = JSON.stringify({
    summary: "The draft is coherent and grounded.",
    revision_notes: ["Keep the PDF-compilation framing explicit."],
    unsupported_claims: [],
    missing_sections: [],
    missing_citations: []
  });
  return [outline, draft, review, draft];
}

function buildExternalCitationResponses(): string[] {
  const outline = JSON.stringify({
    title: "Externally Verified Citation Paper",
    abstract_focus: ["configured evaluation", "citation verification"],
    section_headings: ["Introduction", "Related Work", "Method", "Results", "Conclusion"],
    key_claim_themes: ["External citation verification repairs missing corpus references."],
    citation_plan: ["Recovered External Title"]
  });
  const draft = JSON.stringify({
    title: "Externally Verified Citation Paper",
    abstract: "A paper-writing workflow that can recover missing citations through bounded external verification.",
    keywords: ["configured workflow evaluation", "citation verification"],
    sections: [
      {
        heading: "Introduction",
        paragraphs: ["This paper grounds its framing in an externally recovered citation."],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["Recovered External Title", "paper_1"]
      },
      {
        heading: "Related Work",
        paragraphs: [
          "The externally recovered study provides the declared prior-work anchor for the bounded comparison."
        ],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["Recovered External Title", "paper_1"]
      },
      {
        heading: "Method",
        paragraphs: ["The manuscript cites a missing reference and lets the registry repair it conservatively while Evaluated workflow (primary role) and Reference workflow (baseline role) retain the same protocol."],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["Recovered External Title", "paper_1"]
      },
      {
        heading: "Results",
        paragraphs: ["Bounded external verification restored the missing citation without broadening the claim ceiling."],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["Recovered External Title", "paper_1"]
      },
      {
        heading: "Conclusion",
        paragraphs: ["External citation repair stays local to bibliography support rather than changing the evidence bar."],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["Recovered External Title", "paper_1"]
      }
    ],
    claims: [
      {
        claim_id: "c1",
        statement: "Bounded external verification restored the missing citation without broadening the claim ceiling.",
        section_heading: "Results",
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["Recovered External Title", "paper_1"]
      }
    ]
  });
  const review = JSON.stringify({
    summary: "The draft is coherent and keeps the citation repair bounded.",
    revision_notes: ["Keep the citation repair strictly bibliographic."],
    unsupported_claims: [],
    missing_sections: [],
    missing_citations: []
  });
  return [outline, draft, review, draft];
}

function buildValidationRepairResponses(): string[] {
  const outline = JSON.stringify({
    title: "Configured Evaluation Report",
    abstract_focus: ["configured evaluation", "result traceability"],
    section_headings: ["Introduction", "Method", "Results", "Conclusion"],
    key_claim_themes: ["The evaluated workflow improves result traceability."],
    citation_plan: ["paper_1"]
  });
  const flawedDraft = JSON.stringify({
    title: "Configured Evaluation Report",
    abstract: "A paper-writing workflow with validation-aware repair support.",
    keywords: ["configured workflow evaluation", "paper writing"],
    sections: [
      {
        heading: "Introduction",
        paragraphs: ["This paper studies PDF-backed drafting for configured workflow evaluation workflows."],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      },
      {
        heading: "Method",
        paragraphs: ["The protocol compares Evaluated workflow (primary role) with Reference workflow (baseline role) under the held-out partition before compiling LaTeX."],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      },
      {
        heading: "Results",
        paragraphs: [
          {
            text: "The declared primary comparison remained traceable across repeated evaluations.",
            evidence_ids: [],
            citation_paper_ids: []
          }
        ],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      },
      {
        heading: "Conclusion",
        paragraphs: ["Validation-aware repair makes the writer more self-correcting."],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      }
    ],
    claims: [
      {
        claim_id: "c1",
        statement: "The declared primary comparison remained traceable across repeated evaluations.",
        section_heading: "Results",
        evidence_ids: [],
        citation_paper_ids: []
      }
    ]
  });
  const review = JSON.stringify({
    summary: "The draft is coherent but should make evidence links explicit.",
    revision_notes: ["Keep the PDF-compilation framing explicit."],
    unsupported_claims: [],
    missing_sections: [],
    missing_citations: ["Results"]
  });
  const repairedDraft = JSON.stringify({
    title: "Configured Evaluation Report",
    abstract: "A paper-writing workflow with validation-aware repair support.",
    keywords: ["configured workflow evaluation", "paper writing"],
    sections: [
      {
        heading: "Introduction",
        paragraphs: ["This paper studies PDF-backed drafting for configured workflow evaluation workflows."],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      },
      {
        heading: "Method",
        paragraphs: ["The protocol compares Evaluated workflow (primary role) with Reference workflow (baseline role) under the held-out partition before compiling LaTeX."],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      },
      {
        heading: "Results",
        paragraphs: [
          {
            text: "The declared primary comparison remained traceable across repeated evaluations.",
            evidence_ids: ["ev_1"],
            citation_paper_ids: ["paper_1"]
          }
        ],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      },
      {
        heading: "Conclusion",
        paragraphs: ["Validation-aware repair makes the writer more self-correcting."],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      }
    ],
    claims: [
      {
        claim_id: "c1",
        statement: "The declared primary comparison remained traceable across repeated evaluations.",
        section_heading: "Results",
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      }
    ]
  });
  return [outline, flawedDraft, review, flawedDraft, repairedDraft];
}

function buildRelatedWorkScoutResponses(): string[] {
  const outline = JSON.stringify({
    title: "Configured Evaluation Report",
    abstract_focus: ["configured evaluation", "related work coverage"],
    section_headings: ["Introduction", "Related Work", "Method", "Results", "Conclusion"],
    key_claim_themes: ["The evaluated workflow improves result traceability."],
    citation_plan: ["paper_1", "paper_scout_1"]
  });
  const draft = JSON.stringify({
    title: "Configured Evaluation Report",
    abstract: "A paper-writing workflow with related-work scouting support.",
    keywords: ["configured workflow evaluation", "paper writing", "related work"],
    sections: [
      {
        heading: "Introduction",
        paragraphs: ["This paper studies PDF-backed drafting for configured workflow evaluation workflows."],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      },
      {
        heading: "Related Work",
        paragraphs: [
          {
            text: "Recent related-work scouting highlights complementary literature on outcome score and related evidence synthesis.",
            evidence_ids: ["ev_1"],
            citation_paper_ids: ["paper_1", "paper_scout_1", "paper_scout_2"]
          }
        ],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1", "paper_scout_1", "paper_scout_2"]
      },
      {
        heading: "Method",
        paragraphs: ["The protocol compares Evaluated workflow (primary role) with Reference workflow (baseline role) under the held-out partition before compiling LaTeX."],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      },
      {
        heading: "Results",
        paragraphs: ["The declared primary comparison remained traceable across repeated evaluations."],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      },
      {
        heading: "Conclusion",
        paragraphs: ["Scoped literature scouting helps the writer place results in context."],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1", "paper_scout_1", "paper_scout_2"]
      }
    ],
    claims: [
      {
        claim_id: "c1",
        statement: "The declared primary comparison remained traceable across repeated evaluations.",
        section_heading: "Results",
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      }
    ]
  });
  const review = JSON.stringify({
    summary: "The draft is coherent and now cites related work more explicitly.",
    revision_notes: ["Keep the related-work framing concise."],
    unsupported_claims: [],
    missing_sections: [],
    missing_citations: []
  });
  return [outline, draft, review, draft];
}

function buildSubmissionValidationFailureResponses(): string[] {
  const manuscript = JSON.stringify({
    title: "Configured Evaluation Report",
    abstract: "A submission draft that should fail validation before PDF build.",
    keywords: ["configured workflow evaluation", "paper writing"],
    sections: [
      {
        heading: "Introduction",
        paragraphs: ["This paragraph incorrectly exposes ev_1 inside the submission manuscript."]
      },
      {
        heading: "Method",
        paragraphs: ["The protocol compares Evaluated workflow (primary role) with Reference workflow (baseline role) under the held-out partition before compiling LaTeX."]
      },
      {
        heading: "Results",
        paragraphs: ["The declared primary comparison remained traceable across repeated evaluations."]
      },
      {
        heading: "Conclusion",
        paragraphs: ["Validation should stop PDF generation when the manuscript leaks raw trace tokens."]
      }
    ]
  });
  return [...buildSessionResponses(), manuscript];
}

function buildManuscriptReviewResponse(input: {
  decision: "pass" | "repair" | "stop";
  issues?: Array<{
    code: string;
    severity?: "warning" | "fail";
    section: string;
    repairable?: boolean;
    message: string;
    fix_recommendation: string;
    supporting_spans?: Array<{
      section: string;
      paragraph_index: number;
      excerpt: string;
      reason?: string;
    }>;
    visual_targets?: Array<{
      kind: "table" | "figure" | "appendix_table" | "appendix_figure";
      index: number;
      rationale?: string;
    }>;
  }>;
}): string {
  const status = input.decision === "pass" ? "pass" : input.decision === "repair" ? "warn" : "fail";
  return JSON.stringify({
    overall_decision: input.decision,
    summary: input.decision === "pass" ? "The polished manuscript reads like a paper." : "The polished manuscript needs local revision.",
    checks: {
      section_completeness: { status, note: "Checked." },
      paragraph_redundancy: { status, note: "Checked." },
      related_work_quality: { status, note: "Checked." },
      section_transition: { status, note: "Checked." },
      visual_redundancy: { status, note: "Checked." },
      appendix_hygiene: { status, note: "Checked." },
      citation_hygiene: { status, note: "Checked." },
      alignment: { status, note: "Checked." },
      rhetorical_overreach: { status, note: "Checked." }
    },
    issues: input.issues || []
  });
}

function buildManuscriptReviewAuditResponse(input?: {
  ok?: boolean;
  artifact_reliability?: "grounded" | "partially_grounded" | "degraded";
  retry_recommended?: boolean;
  summary?: string;
  issues?: Array<{
    severity?: "warning" | "fail";
    code: "unsupported_issue" | "missing_major_issue" | "check_issue_mismatch" | "insufficient_grounding";
    section: string;
    message: string;
    fix_recommendation: string;
  }>;
}): string {
  return JSON.stringify({
    ok: input?.ok ?? true,
    artifact_reliability: input?.artifact_reliability ?? "grounded",
    retry_recommended: input?.retry_recommended ?? false,
    summary: input?.summary ?? "The manuscript review artifact is sufficiently grounded.",
    issues: input?.issues || []
  });
}

function buildPolishedManuscriptResponse(overrides?: Partial<any>): string {
  return JSON.stringify({
    title: "Role-Bound Reporting for Auditable Workflow Evaluation",
    abstract:
      "We study auditable reporting for a configured workflow comparison. The evaluated and reference workflows are measured under the same repeated protocol, and the observed outcome remains bounded to the declared evaluation scope.",
    keywords: ["workflow evaluation", "result traceability"],
    sections: [
      {
        heading: "Introduction",
        paragraphs: [
          "Research reports can lose the explicit links among declared series, observations, and comparison claims during revision.",
          "This study evaluates whether role-bound result artifacts preserve those links through the paper-writing workflow.",
          "The contribution is a bounded evaluation of traceable comparison reporting under a fixed protocol, without extending the claim beyond the inspected suite."
        ]
      },
      {
        heading: "Related Work",
        paragraphs: [
          "Prior work separates result-schema validation, workflow evaluation, and evidence-grounded scientific reporting into distinct lines of study.",
          "Compared with those strands, this study examines how explicit series roles and observation links constrain a primary comparison during manuscript production."
        ]
      },
      {
        heading: "Method",
        paragraphs: [
          "The protocol compares Evaluated workflow (primary role) with Reference workflow (baseline role) on evaluation_suite under the held-out partition.",
          "Both series use the same preprocessing order, fold-internal fitting scope, and fixed selection procedure.",
          "The primary outcome, runtime, and peak-memory measurements are linked to explicit observations rather than inferred from labels or array order.",
          "Repeated stratified evaluations use declared seeds, an outer evaluation loop, and an inner selection loop.",
          "The configured search space, execution budget, and reporting units remain fixed across both series."
        ]
      },
      {
        heading: "Results",
        paragraphs: [
          "The declared primary comparison reports a bounded subject-minus-reference difference for the held-out partition.",
          "The main table preserves the exact linked observations, while the figure visualizes only the same role-bound comparison.",
          "Repeated measurements and the reported interval support a cautious interpretation of the observed difference."
        ]
      },
      {
        heading: "Discussion",
        paragraphs: [
          "The result suggests that explicit comparison semantics can keep quantitative reporting auditable without implying broad generalization beyond the tested workflow.",
          "The practical value lies in preserving the declared roles, scope, and evidence references across manuscript revisions."
        ]
      },
      {
        heading: "Limitations",
        paragraphs: [
          "The evaluation is limited to one configured suite and one declared comparison, so broader claims require additional tasks, references, and execution settings."
        ]
      },
      {
        heading: "Conclusion",
        paragraphs: [
          "Within the tested workflow setting, the role-bound artifact supports a traceable and conservatively scoped primary comparison.",
          "The paper keeps the central comparison in the main body and routes detailed protocol and repeat-level evidence to the appendix."
        ]
      }
    ],
    tables: [
      {
        caption: "Declared primary comparison for the outcome score.",
        rows: [
          { label: "Reference workflow", value: 0.71 },
          { label: "Evaluated workflow", value: 0.76 }
        ]
      }
    ],
    appendix_sections: [],
    appendix_tables: [],
    appendix_figures: [],
    ...(overrides || {})
  });
}

function buildWrappedRepairResponse(manuscript: Record<string, unknown>, overrides?: Partial<{
  resolved_target_anchor_ids: string[];
  changed_location_keys: string[];
  unchanged_anchor_ids_sample: string[];
  notes: string;
}>): string {
  return JSON.stringify({
    revised_manuscript: manuscript,
    resolved_target_anchor_ids: overrides?.resolved_target_anchor_ids || [],
    changed_location_keys: overrides?.changed_location_keys || [],
    unchanged_anchor_ids_sample: overrides?.unchanged_anchor_ids_sample || [],
    notes: overrides?.notes || "Applied only the requested local manuscript edits."
  });
}

function buildManuscriptRepairOnceResponses(): string[] {
  const initial = JSON.parse(buildPolishedManuscriptResponse()) as any;
  initial.sections[4].paragraphs[0] = initial.sections[0].paragraphs[0];
  const repaired = JSON.parse(buildPolishedManuscriptResponse()) as any;
  return [
    ...buildSessionResponses(),
    JSON.stringify(initial),
    buildManuscriptReviewResponse({
      decision: "repair",
      issues: [
        {
          code: "paragraph_redundancy",
          severity: "warning",
          section: "Discussion",
          repairable: true,
          message: "Discussion repeats the opening framing from Introduction.",
          fix_recommendation: "Rewrite the Discussion opening to interpret the results instead of repeating the setup.",
          supporting_spans: [
            {
              section: "Discussion",
              paragraph_index: 0,
              excerpt: initial.sections[4].paragraphs[0],
              reason: "Repeated setup language appears in the discussion opening."
            }
          ]
        }
      ]
    }),
    buildManuscriptReviewAuditResponse(),
    buildWrappedRepairResponse(repaired, {
      changed_location_keys: ["paragraph:discussion:0"]
    }),
    buildManuscriptReviewResponse({ decision: "pass" }),
    buildManuscriptReviewAuditResponse()
  ];
}

function buildSectionTransitionAdjacentRepairResponses(): string[] {
  const initial = JSON.parse(buildPolishedManuscriptResponse()) as any;
  initial.sections[3].paragraphs[0] =
    "The Results section first states the declared role-bound comparison under the common evaluation protocol.";
  initial.sections[3].paragraphs[1] =
    "The next results paragraph repeats setup details instead of moving into interpretation, so the local transition currently feels abrupt.";
  const repaired = JSON.parse(buildPolishedManuscriptResponse()) as any;
  repaired.sections[3].paragraphs[0] =
    "The Results section first states the declared role-bound comparison before moving into interpretation.";
  repaired.sections[3].paragraphs[1] =
    "This local transition lets the next paragraph interpret the bounded difference without reintroducing the setup.";
  return [
    ...buildSessionResponses(),
    JSON.stringify(initial),
    buildManuscriptReviewResponse({
      decision: "repair",
      issues: [
        {
          code: "section_transition",
          severity: "warning",
          section: "Results",
          repairable: true,
          message: "The results opening does not transition naturally into the following interpretation paragraph.",
          fix_recommendation: "Revise the local bridge between the two results paragraphs without rewriting the section.",
          supporting_spans: [
            {
              section: "Results",
              paragraph_index: 0,
              excerpt: initial.sections[3].paragraphs[0],
              reason: "This paragraph needs a cleaner bridge into the next results paragraph."
            }
          ]
        }
      ]
    }),
    buildManuscriptReviewAuditResponse(),
    buildWrappedRepairResponse(repaired, {
      changed_location_keys: ["paragraph:results:0", "paragraph:results:1"]
    }),
    buildManuscriptReviewResponse({ decision: "pass" }),
    buildManuscriptReviewAuditResponse()
  ];
}

function buildSectionTransitionRepairWithGlobalCleanupNoiseResponses(): string[] {
  const initial = JSON.parse(buildPolishedManuscriptResponse()) as any;
  initial.sections[2].paragraphs[2] =
    "The executed run repeated the configured setup as the configured setup. Extra method details remain conservative.";
  initial.sections[3].paragraphs[0] =
    "The Results section first states the declared role-bound comparison under the common evaluation protocol.";
  initial.sections[3].paragraphs[1] =
    "The next results paragraph repeats setup details instead of moving into interpretation, so the local transition currently feels abrupt.";
  const repaired = structuredClone(initial);
  repaired.sections[3].paragraphs[0] =
    "The Results section first states the declared role-bound comparison before moving into interpretation.";
  repaired.sections[3].paragraphs[1] =
    "This local transition lets the next paragraph interpret the bounded difference without reintroducing the setup.";
  return [
    ...buildSessionResponses(),
    JSON.stringify(initial),
    buildManuscriptReviewResponse({
      decision: "repair",
      issues: [
        {
          code: "section_transition",
          severity: "warning",
          section: "Results",
          repairable: true,
          message: "The results opening does not transition naturally into the following interpretation paragraph.",
          fix_recommendation: "Revise the local bridge between the two results paragraphs without rewriting the section.",
          supporting_spans: [
            {
              section: "Results",
              paragraph_index: 0,
              excerpt: initial.sections[3].paragraphs[0],
              reason: "This paragraph needs a cleaner bridge into the next results paragraph."
            }
          ]
        }
      ]
    }),
    buildManuscriptReviewAuditResponse(),
    buildWrappedRepairResponse(repaired, {
      changed_location_keys: ["paragraph:results:0", "paragraph:results:1"]
    }),
    buildManuscriptReviewResponse({ decision: "pass" }),
    buildManuscriptReviewAuditResponse()
  ];
}

function buildIntroductionAlignmentAdjacentRepairResponses(): string[] {
  const initial = JSON.parse(buildPolishedManuscriptResponse()) as any;
  initial.sections[0].paragraphs[0] =
    "Manuscript generation for configured workflow evaluation workflows is difficult because revisions can drift away from grounded evidence and leave the overall story misaligned.";
  initial.sections[0].paragraphs[1] =
    "This paper evaluates whether the evaluated workflow can preserve explicit evidence links, but the local framing does not yet line up tightly with the abstract and conclusion.";
  const repaired = JSON.parse(buildPolishedManuscriptResponse()) as any;
  repaired.sections[0].paragraphs[0] =
    "Manuscript generation for configured workflow evaluation workflows is difficult because revisions can drift away from grounded evidence and obscure the tested contribution.";
  repaired.sections[0].paragraphs[1] =
    "This paper therefore evaluates whether the evaluated workflow preserves explicit evidence links within the tested workflow setting, matching the abstract and conclusion without broadening the claim.";
  return [
    ...buildSessionResponses(),
    JSON.stringify(initial),
    buildManuscriptReviewResponse({
      decision: "repair",
      issues: [
        {
          code: "alignment",
          severity: "warning",
          section: "Introduction",
          repairable: true,
          message: "The introduction framing needs tighter alignment with the abstract and conclusion.",
          fix_recommendation: "Revise the local introduction framing without rewriting the whole section.",
          supporting_spans: [
            {
              section: "Introduction",
              paragraph_index: 1,
              excerpt: initial.sections[0].paragraphs[1],
              reason: "This framing paragraph should align more closely with the abstract and conclusion."
            }
          ]
        }
      ]
    }),
    buildManuscriptReviewAuditResponse(),
    buildWrappedRepairResponse(repaired, {
      changed_location_keys: ["paragraph:introduction:0", "paragraph:introduction:1"]
    }),
    buildManuscriptReviewResponse({ decision: "pass" }),
    buildManuscriptReviewAuditResponse()
  ];
}

function buildVisualRedundancyPairRepairResponses(): string[] {
  const sharedTableRows = [
    { label: "Reference workflow", value: 0.71 },
    { label: "The evaluated workflow", value: 0.76 },
    { label: "Observed delta", value: 0.05 }
  ];
  const preservedTradeoffBars = [
    { label: "Auxiliary observation A", value: 0.52 },
    { label: "Auxiliary observation B", value: 0.61 },
    { label: "Auxiliary observation C", value: 0.57 }
  ];
  const initial = JSON.parse(
    buildPolishedManuscriptResponse({
      tables: [
        {
          caption: "Exact numeric comparison for outcome score.",
          rows: sharedTableRows
        }
      ],
      figures: [
        {
          caption: "A redundant bar chart restating the exact role-bound outcome comparison.",
          bars: sharedTableRows
        },
        {
          caption: "A separate tradeoff figure that should remain unchanged.",
          bars: preservedTradeoffBars
        }
      ]
    })
  ) as any;
  const repaired = JSON.parse(
    buildPolishedManuscriptResponse({
      tables: [
        {
          caption: "Exact numeric comparison for outcome score.",
          rows: sharedTableRows
        }
      ]
    })
  ) as any;
  repaired.figures = [
    {
      caption: "A trend-focused figure highlighting the subject-reference difference without restating the full table.",
      bars: [
        { label: "Subject-reference difference", value: 0.05 },
        { label: "The evaluated workflow", value: 0.76 },
        { label: "Reference workflow", value: 0.71 }
      ]
    },
    {
      caption: "A separate tradeoff figure that should remain unchanged.",
      bars: preservedTradeoffBars
    }
  ];
  return [
    ...buildSessionResponses(),
    JSON.stringify(initial),
    buildManuscriptReviewResponse({
      decision: "repair",
      summary: "The manuscript reads well overall, but one visual pair is redundant.",
      issues: [
        {
          code: "visual_redundancy",
          severity: "warning",
          section: "Results",
          repairable: true,
          message: "Figure 1 restates Table 1 instead of adding a distinct visual pattern.",
          fix_recommendation: "Keep the exact table and revise Figure 1 so it communicates a narrower trend-focused takeaway.",
          visual_targets: [
            {
              kind: "table",
              index: 0,
              rationale: "Table 1 is one half of the redundant pair and should remain numerically precise."
            },
            {
              kind: "figure",
              index: 0,
              rationale: "Figure 1 is the redundant visual that should be revised into a distinct trend-focused figure."
            }
          ]
        }
      ]
    }),
    buildManuscriptReviewAuditResponse(),
    buildWrappedRepairResponse(repaired, {
      changed_location_keys: ["figure:0"]
    }),
    buildManuscriptReviewResponse({ decision: "pass" }),
    buildManuscriptReviewAuditResponse()
  ];
}

function buildVisualCaptionOverclaimRepairResponses(): string[] {
  const sharedTableRows = [
    { label: "Reference workflow", value: 0.71 },
    { label: "The evaluated workflow", value: 0.76 },
    { label: "Observed delta", value: 0.05 }
  ];
  const preservedTradeoffBars = [
    { label: "Auxiliary observation A", value: 0.52 },
    { label: "Auxiliary observation B", value: 0.61 },
    { label: "Auxiliary observation C", value: 0.57 }
  ];
  const initial = JSON.parse(
    buildPolishedManuscriptResponse({
      tables: [
        {
          caption: "Exact numeric comparison for outcome score.",
          rows: sharedTableRows
        }
      ],
      figures: [
        {
          caption: "A redundant bar chart restating the exact role-bound outcome comparison.",
          bars: sharedTableRows
        },
        {
          caption: "A separate tradeoff figure that should remain unchanged.",
          bars: preservedTradeoffBars
        }
      ]
    })
  ) as any;
  const repaired = JSON.parse(
    buildPolishedManuscriptResponse({
      tables: [
        {
          caption: "Exact numeric comparison for outcome score.",
          rows: sharedTableRows
        }
      ]
    })
  ) as any;
  repaired.figures = [
    {
      caption: "This figure clearly demonstrates broad applicability across domains.",
      bars: [
        { label: "Subject-reference difference", value: 0.05 },
        { label: "The evaluated workflow", value: 0.76 },
        { label: "Reference workflow", value: 0.71 }
      ]
    },
    {
      caption: "A separate tradeoff figure that should remain unchanged.",
      bars: preservedTradeoffBars
    }
  ];
  return [
    ...buildSessionResponses(),
    JSON.stringify(initial),
    buildManuscriptReviewResponse({
      decision: "repair",
      summary: "The manuscript reads well overall, but one visual pair is redundant.",
      issues: [
        {
          code: "visual_redundancy",
          severity: "warning",
          section: "Results",
          repairable: true,
          message: "Figure 1 restates Table 1 instead of adding a distinct visual pattern.",
          fix_recommendation: "Keep the exact table and revise Figure 1 so it communicates a narrower trend-focused takeaway.",
          visual_targets: [
            { kind: "table", index: 0, rationale: "Table 1 is one half of the redundant pair." },
            { kind: "figure", index: 0, rationale: "Figure 1 is the redundant visual that should be revised." }
          ]
        }
      ]
    }),
    buildManuscriptReviewAuditResponse(),
    buildWrappedRepairResponse(repaired, {
      changed_location_keys: ["figure:0"]
    }),
    buildManuscriptReviewResponse({ decision: "pass" }),
    buildManuscriptReviewAuditResponse()
  ];
}

function buildAppendixHardStopResponses(): string[] {
  const contaminated = JSON.parse(
    buildPolishedManuscriptResponse({
      appendix_sections: [
        {
          heading: "Appendix. Notes",
          paragraphs: [
            "TODO: keep topic fixed and inspect .autolabos/runs/run-1/result_analysis.json before finalizing."
          ]
        }
      ]
    })
  ) as any;
  return [
    ...buildSessionResponses(),
    JSON.stringify(contaminated),
    buildManuscriptReviewResponse({ decision: "pass" }),
    buildManuscriptReviewAuditResponse()
  ];
}

function buildAppendixBackstopRepairResponses(): string[] {
  const contaminated = JSON.parse(
    buildPolishedManuscriptResponse({
      appendix_sections: [
        {
          heading: "Appendix. Notes",
          paragraphs: [
            "TODO: keep topic fixed and inspect .autolabos/runs/run-1/result_analysis.json before finalizing."
          ]
        }
      ]
    })
  ) as any;
  const repaired = JSON.parse(
    buildPolishedManuscriptResponse({
      appendix_sections: [
        {
          heading: "Appendix. Notes",
          paragraphs: [
            "Supplementary protocol notes summarize the repeated-run setup for readers."
          ]
        }
      ]
    })
  ) as any;
  return [
    ...buildSessionResponses(),
    JSON.stringify(contaminated),
    buildManuscriptReviewResponse({
      decision: "repair",
      issues: [
        {
          code: "appendix_hygiene",
          severity: "fail",
          section: "Appendix",
          repairable: true,
          message: "The appendix contains internal planning language and raw artifact references.",
          fix_recommendation: "Replace the contaminated appendix note with reader-facing supplementary detail.",
          supporting_spans: [
            {
              section: "Appendix. Notes",
              paragraph_index: 0,
              excerpt: "TODO: keep topic fixed",
              reason: "This appendix paragraph contains internal/meta residue."
            }
          ]
        }
      ]
    }),
    buildManuscriptReviewAuditResponse(),
    buildWrappedRepairResponse(repaired, {
      changed_location_keys: ["appendix_paragraph:appendix._notes:0"]
    }),
    buildManuscriptReviewResponse({ decision: "pass" }),
    buildManuscriptReviewAuditResponse()
  ];
}

function buildTableCaptionOverclaimRepairResponses(): string[] {
  const sharedTableRows = [
    { label: "Reference workflow", value: 0.71 },
    { label: "The evaluated workflow", value: 0.76 },
    { label: "Observed delta", value: 0.05 }
  ];
  const initial = JSON.parse(
    buildPolishedManuscriptResponse({
      tables: [
        {
          caption: "Exact numeric comparison for outcome score.",
          rows: sharedTableRows
        }
      ]
    })
  ) as any;
  const repaired = JSON.parse(
    buildPolishedManuscriptResponse({
      tables: [
        {
          caption: "This table clearly demonstrates broad applicability across domains.",
          rows: sharedTableRows
        }
      ]
    })
  ) as any;
  return [
    ...buildSessionResponses(),
    JSON.stringify(initial),
    buildManuscriptReviewResponse({
      decision: "repair",
      issues: [
        {
          code: "visual_redundancy",
          severity: "fail",
          section: "Results",
          repairable: true,
          message: "Table 1 caption should be narrowed to a scoped numeric comparison.",
          fix_recommendation: "Keep the numeric table but constrain the caption to the tested setting.",
          visual_targets: [{ kind: "table", index: 0, rationale: "The table caption is the local repair surface." }]
        }
      ]
    }),
    buildManuscriptReviewAuditResponse(),
    buildWrappedRepairResponse(repaired, {
      changed_location_keys: ["table:0"]
    }),
    buildManuscriptReviewResponse({ decision: "pass" }),
    buildManuscriptReviewAuditResponse()
  ];
}

function buildVisualLabelOverclaimRepairResponses(): string[] {
  const initial = JSON.parse(
    buildPolishedManuscriptResponse({
      figures: [
        {
          caption: "A trend-focused figure highlighting the subject-reference difference.",
          bars: [
            { label: "Subject-reference difference", value: 0.05 },
            { label: "The evaluated workflow", value: 0.76 },
            { label: "Reference workflow", value: 0.71 }
          ]
        }
      ]
    })
  ) as any;
  const repaired = JSON.parse(
    buildPolishedManuscriptResponse({
      figures: [
        {
          caption: "A trend-focused figure highlighting the subject-reference difference.",
          bars: [
            { label: "Broad applicability across domains", value: 0.05 },
            { label: "The evaluated workflow", value: 0.76 },
            { label: "Reference workflow", value: 0.71 }
          ]
        }
      ]
    })
  ) as any;
  return [
    ...buildSessionResponses(),
    JSON.stringify(initial),
    buildManuscriptReviewResponse({
      decision: "repair",
      issues: [
        {
          code: "visual_redundancy",
          severity: "warning",
          section: "Results",
          repairable: true,
          message: "Figure 1 should keep a scoped label for the changed trend bar.",
          fix_recommendation: "Keep the figure focused on the observed comparison pattern within the tested setting.",
          visual_targets: [{ kind: "figure", index: 0, rationale: "Figure 1 is the local repair surface." }]
        }
      ]
    }),
    buildManuscriptReviewAuditResponse(),
    buildWrappedRepairResponse(repaired, {
      changed_location_keys: ["figure:0"]
    }),
    buildManuscriptReviewResponse({ decision: "pass" }),
    buildManuscriptReviewAuditResponse()
  ];
}

function buildPartiallyGroundedRepairStopResponses(options?: {
  auditIssueCode?: "unsupported_issue" | "missing_major_issue" | "check_issue_mismatch" | "insufficient_grounding";
  auditIssueSeverity?: "warning" | "fail";
  followupIssueSeverity?: "warning" | "fail";
}): string[] {
  const initial = JSON.parse(buildPolishedManuscriptResponse()) as any;
  const repair1 = JSON.parse(buildPolishedManuscriptResponse()) as any;
  repair1.sections[0].paragraphs[1] =
    "The introduction now frames the contribution around the declared primary outcome in the tested workflow setting.";
  const repair2 = JSON.parse(buildPolishedManuscriptResponse()) as any;
  repair2.sections[0].paragraphs[1] = repair1.sections[0].paragraphs[1];
  repair2.sections[1].paragraphs = [
    "Prior work studies outcome score and workflow benchmarking as separate concerns.",
    "Compared with those strands, this study isolates the configured evaluation-state comparison within one workflow setting, making the comparison axis explicit."
  ];
  const auditIssueCode = options?.auditIssueCode ?? "insufficient_grounding";
  return [
    ...buildSessionResponses(),
    JSON.stringify(initial),
    buildManuscriptReviewResponse({
      decision: "repair",
      issues: [
        {
          code: "paragraph_redundancy",
          severity: "warning",
          section: "Introduction",
          repairable: true,
          message: "Introduction framing overlaps with the abstract.",
          fix_recommendation: "Make the introduction's contribution framing more local and distinct.",
          supporting_spans: [
            {
              section: "Introduction",
              paragraph_index: 1,
              excerpt: initial.sections[0].paragraphs[1],
              reason: "This paragraph repeats the abstract framing too closely."
            }
          ]
        }
      ]
    }),
    buildManuscriptReviewAuditResponse(),
    buildWrappedRepairResponse(repair1, {
      changed_location_keys: ["paragraph:introduction:1"]
    }),
    buildManuscriptReviewResponse({
      decision: "repair",
      issues: [
        {
          code: "related_work_quality",
          severity: options?.followupIssueSeverity ?? "warning",
          section: "Related Work",
          repairable: true,
          message: "Related Work still needs a sharper comparison axis.",
          fix_recommendation: "State the comparison axis more explicitly.",
          supporting_spans: [
            {
              section: "Related Work",
              paragraph_index: 1,
              excerpt: repair1.sections[1].paragraphs[1],
              reason: "The comparison axis is still usable but underspecified."
            }
          ]
        }
      ]
    }),
    buildManuscriptReviewAuditResponse({
      ok: true,
      artifact_reliability: "partially_grounded",
      retry_recommended: false,
      summary: "The follow-up review is usable, but one warning-level grounding mismatch remains.",
      issues: [
        {
          severity: options?.auditIssueSeverity ?? "fail",
          code: auditIssueCode,
          section: "Related Work",
          message: "The surviving Related Work issue is directionally useful but not fully grounded enough for another repair pass.",
          fix_recommendation: "Do not spend a second repair pass on a partially grounded review artifact."
        }
      ]
    }),
    buildWrappedRepairResponse(repair2, {
      changed_location_keys: ["paragraph:related_work:1"]
    }),
    buildManuscriptReviewResponse({
      decision: "pass",
      issues: []
    }),
    buildManuscriptReviewAuditResponse({
      ok: true,
      artifact_reliability: "grounded",
      issues: []
    })
  ];
}

function buildManuscriptRepairTwiceResponses(options?: { unresolvedAfterSecond?: boolean }): string[] {
  const initial = JSON.parse(buildPolishedManuscriptResponse()) as any;
  const repair1 = JSON.parse(buildPolishedManuscriptResponse()) as any;
  repair1.sections[0].paragraphs[1] =
    "The introduction frames the contribution around outcome score in the tested workflow setting, rather than repeating the abstract framing.";
  const repair2 = JSON.parse(buildPolishedManuscriptResponse()) as any;
  repair2.sections[0].paragraphs[1] = repair1.sections[0].paragraphs[1];
  repair2.sections[1].paragraphs = [
    "Prior work studies explicit result semantics, while workflow benchmarking studies orchestration quality at the system level.",
    "Compared with those strands, the current study isolates configured evaluation state within a single workflow setting, making the comparison axis explicit rather than leaving it implied."
  ];
  const finalDecision = options?.unresolvedAfterSecond
    ? buildManuscriptReviewResponse({
        decision: "repair",
        issues: [
          {
            code: "alignment",
            severity: "warning",
            section: "Conclusion",
            repairable: true,
            message: "Conclusion still needs a slightly tighter alignment with the abstract.",
            fix_recommendation: "Tighten the conclusion to mirror the abstract's scope."
          }
        ]
      })
    : buildManuscriptReviewResponse({ decision: "pass" });
  return [
    ...buildSessionResponses(),
    JSON.stringify(initial),
    buildManuscriptReviewResponse({
      decision: "repair",
      issues: [
        {
          code: "paragraph_redundancy",
          severity: "fail",
          section: "Introduction",
          repairable: true,
          message: "Introduction and abstract use overlapping framing.",
          fix_recommendation: "Make the introduction's second paragraph contribution-oriented.",
          supporting_spans: [
            {
              section: "Introduction",
              paragraph_index: 1,
              excerpt: initial.sections[0].paragraphs[1],
              reason: "The contribution framing is too close to the abstract."
            }
          ]
        }
      ]
    }),
    buildManuscriptReviewAuditResponse(),
    buildWrappedRepairResponse(repair1, {
      changed_location_keys: ["paragraph:introduction:1"]
    }),
    buildManuscriptReviewResponse({
      decision: "repair",
      issues: [
        {
          code: "related_work_quality",
          severity: "fail",
          section: "Related Work",
          repairable: true,
          message: "Related Work still needs a sharper comparison axis.",
          fix_recommendation: "State the comparison axis explicitly and contrast prior strands with the current study.",
          supporting_spans: [
            {
              section: "Related Work",
              paragraph_index: 1,
              excerpt: repair1.sections[1].paragraphs[1],
              reason: "The comparison axis is still underspecified."
            }
          ]
        }
      ]
    }),
    buildManuscriptReviewAuditResponse(),
    buildWrappedRepairResponse(repair2, {
      changed_location_keys: ["paragraph:related_work:0", "paragraph:related_work:1"]
    }),
    finalDecision,
    buildManuscriptReviewAuditResponse()
  ];
}

function buildNarrowBlockingRepairAfterNetImprovementResponses(): string[] {
  const initial = JSON.parse(buildPolishedManuscriptResponse()) as any;
  initial.sections[2].paragraphs[0] =
    "The Method names the evaluated and reference workflows, but the realized setup is not stated cleanly enough for reconstruction.";
  initial.sections[4].paragraphs[0] = initial.sections[0].paragraphs[0];

  const repair1 = JSON.parse(buildPolishedManuscriptResponse()) as any;
  repair1.sections[2].paragraphs[0] =
    "The Method compares Evaluated workflow (primary role) with Reference workflow (baseline role) on evaluation_suite, but the realized execution setting remains ambiguous.";
  repair1.sections[4].paragraphs[0] =
    "The result is best interpreted as a narrow role-bound outcome comparison within the tested workflow setting.";

  const repair2 = JSON.parse(buildPolishedManuscriptResponse()) as any;
  repair2.sections[2].paragraphs[0] =
    "The Method compares Evaluated workflow (primary role) with Reference workflow (baseline role) on evaluation_suite using the same realized evaluation setup for both series.";

  return [
    ...buildSessionResponses(),
    JSON.stringify(initial),
    buildManuscriptReviewResponse({
      decision: "repair",
      issues: [
        {
          code: "section_completeness",
          severity: "warning",
          section: "Method",
          repairable: true,
          message: "The Method does not cleanly state the realized setup.",
          fix_recommendation: "State the realized setup in the Method without broad rewrites.",
          supporting_spans: [
            {
              section: "Method",
              paragraph_index: 0,
              excerpt: initial.sections[2].paragraphs[0],
              reason: "The realized setup remains underspecified."
            }
          ]
        },
        {
          code: "paragraph_redundancy",
          severity: "warning",
          section: "Discussion",
          repairable: true,
          message: "Discussion repeats the abstract framing.",
          fix_recommendation: "Rewrite the discussion opening to interpret the result.",
          supporting_spans: [
            {
              section: "Discussion",
              paragraph_index: 0,
              excerpt: initial.sections[4].paragraphs[0],
              reason: "This repeats the abstract framing."
            }
          ]
        }
      ]
    }),
    buildManuscriptReviewAuditResponse(),
    buildWrappedRepairResponse(repair1, {
      changed_location_keys: ["paragraph:method:0", "paragraph:discussion:0"]
    }),
    buildManuscriptReviewResponse({
      decision: "repair",
      issues: [
        {
          code: "section_completeness",
          severity: "fail",
          section: "Method",
          repairable: true,
          message: "The Method still gives an ambiguous account of the realized setup.",
          fix_recommendation: "Resolve the Method setup statement directly.",
          supporting_spans: [
            {
              section: "Method",
              paragraph_index: 0,
              excerpt: repair1.sections[2].paragraphs[0],
              reason: "The realized setup is still ambiguous."
            }
          ]
        }
      ]
    }),
    buildManuscriptReviewAuditResponse(),
    buildWrappedRepairResponse(repair2, {
      changed_location_keys: ["paragraph:method:0"]
    }),
    buildManuscriptReviewResponse({ decision: "pass" }),
    buildManuscriptReviewAuditResponse()
  ];
}

function buildRepeatedLintRepairResponses(): string[] {
  const contaminated = JSON.parse(buildPolishedManuscriptResponse({
    abstract:
      "We study auditable reporting for a configured workflow comparison. The evaluated and reference workflows use the same repeated protocol. These results clearly demonstrate broad applicability beyond the tested workflow setting."
  })) as any;
  return [
    ...buildSessionResponses(),
    JSON.stringify(contaminated),
    buildManuscriptReviewResponse({
      decision: "repair",
      issues: [
        {
          code: "rhetorical_overreach",
          severity: "fail",
          section: "Abstract",
          repairable: true,
          message: "Abstract overstates the scope of the evidence.",
          fix_recommendation: "Constrain the abstract to the tested workflow setting.",
          supporting_spans: [
            {
              section: "Abstract",
              paragraph_index: 0,
              excerpt: "These results clearly demonstrate broad applicability beyond the tested workflow setting.",
              reason: "This sentence exceeds the available evidence scope."
            }
          ]
        }
      ]
    }),
    buildManuscriptReviewAuditResponse(),
    JSON.stringify(contaminated),
    buildManuscriptReviewResponse({
      decision: "repair",
      issues: [
        {
          code: "rhetorical_overreach",
          severity: "fail",
          section: "Abstract",
          repairable: true,
          message: "Abstract still overstates the scope of the evidence.",
          fix_recommendation: "Constrain the abstract to the tested workflow setting.",
          supporting_spans: [
            {
              section: "Abstract",
              paragraph_index: 0,
              excerpt: "These results clearly demonstrate broad applicability beyond the tested workflow setting.",
              reason: "The same unsupported generalization remains."
            }
          ]
        }
      ]
    }),
    buildManuscriptReviewAuditResponse()
  ];
}

function buildOutOfScopeRepairResponses(): string[] {
  const initial = JSON.parse(buildPolishedManuscriptResponse()) as any;
  initial.sections[4].paragraphs[0] = initial.sections[0].paragraphs[0];
  const overbroad = JSON.parse(buildPolishedManuscriptResponse()) as any;
  overbroad.sections[0].paragraphs[0] = "This unrelated introduction rewrite should violate bounded local repair scope.";
  overbroad.sections[2].paragraphs[2] = "This unrelated method rewrite should also be dropped before locality verification.";
  overbroad.sections[4].paragraphs[0] =
    "The discussion now interprets the result instead of repeating the introduction framing.";
  return [
    ...buildSessionResponses(),
    JSON.stringify(initial),
    buildManuscriptReviewResponse({
      decision: "repair",
      issues: [
        {
          code: "paragraph_redundancy",
          severity: "warning",
          section: "Discussion",
          repairable: true,
          message: "Discussion repeats the introduction framing.",
          fix_recommendation: "Rewrite only the discussion opening so it interprets the result.",
          supporting_spans: [
            {
              section: "Discussion",
              paragraph_index: 0,
              excerpt: initial.sections[4].paragraphs[0],
              reason: "This is the duplicated discussion opening."
            }
          ]
        }
      ]
    }),
    buildManuscriptReviewAuditResponse(),
    buildWrappedRepairResponse(overbroad, {
      changed_location_keys: ["paragraph:introduction:0", "paragraph:method:2", "paragraph:discussion:0"]
    }),
    buildManuscriptReviewResponse({ decision: "pass" }),
    buildManuscriptReviewAuditResponse()
  ];
}

function buildReviewRetryResponses(): string[] {
  return [
    ...buildSessionResponses(),
    buildPolishedManuscriptResponse(),
    buildManuscriptReviewResponse({
      decision: "repair",
      issues: [
        {
          code: "alignment",
          severity: "fail",
          section: "Abstract",
          repairable: true,
          message: "Abstract and conclusion need tighter scope alignment.",
          fix_recommendation: "Keep both sections scoped to the tested workflow setting.",
          supporting_spans: [
            {
              section: "Abstract",
              paragraph_index: 9,
              excerpt: "This span points to a paragraph that does not exist.",
              reason: "Malformed grounding from the first review."
            }
          ]
        }
      ]
    }),
    buildManuscriptReviewResponse({ decision: "pass" }),
    buildManuscriptReviewAuditResponse()
  ];
}

async function overwriteRunArtifacts(run: RunRecord, files: Record<string, string>): Promise<void> {
  const runDir = path.join(process.cwd(), ".autolabos", "runs", run.id);
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(runDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, "utf8");
  }
}

async function writeLatestResults(run: RunRecord, payload: Record<string, unknown>): Promise<void> {
  const analysisDir = buildPublicAnalysisDir(process.cwd(), run);
  await mkdir(analysisDir, { recursive: true });
  await writeFile(path.join(analysisDir, "latest_results.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function buildWeakScientificResponses(): string[] {
  const outline = JSON.stringify({
    title: "Weak Evaluation Note",
    abstract_focus: ["weak evidence", "cautious evaluation framing"],
    section_headings: ["Introduction", "Method", "Results", "Conclusion"],
    key_claim_themes: ["The result suggests a small positive difference."],
    citation_plan: ["paper_1"]
  });
  const draft = JSON.stringify({
    title: "Weak Evaluation Note",
    abstract: "A short benchmark note.",
    keywords: ["benchmark"],
    sections: [
      {
        heading: "Introduction",
        paragraphs: ["We study a small configured evaluation."],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      },
      {
        heading: "Method",
        paragraphs: ["We compare Evaluated workflow (primary role) with Reference workflow (baseline role) on one evaluation suite."],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      },
      {
        heading: "Results",
        paragraphs: ["The method demonstrates significant improvement."],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      },
      {
        heading: "Conclusion",
        paragraphs: ["The benchmark is promising."],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      }
    ],
    claims: [
      {
        claim_id: "c1",
        statement: "The method demonstrates significant improvement.",
        section_heading: "Results",
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1"]
      }
    ]
  });
  const review = JSON.stringify({
    summary: "The draft is cautious but still terse.",
    revision_notes: ["Keep the bounded evaluation framing explicit."],
    unsupported_claims: [],
    missing_sections: [],
    missing_citations: []
  });
  const manuscript = JSON.stringify({
    title: "Weak Evaluation Note",
    abstract: "This study demonstrates significant improvement on the evaluation.",
    keywords: ["benchmark"],
    sections: [
      {
        heading: "Introduction",
        paragraphs: ["We study a small configured evaluation."]
      },
      {
        heading: "Method",
        paragraphs: ["We compare Evaluated workflow (primary role) with Reference workflow (baseline role) on one evaluation suite."]
      },
      {
        heading: "Results",
        paragraphs: ["The evaluation suggests a positive difference within its declared scope."]
      },
      {
        heading: "Conclusion",
        paragraphs: ["The evidence remains limited but encouraging."]
      }
    ]
  });
  return [outline, draft, review, manuscript];
}

function buildMediumScientificResponses(): string[] {
  const outline = JSON.stringify({
    title: "Repeated Workflow Evaluation",
    abstract_focus: ["declared comparison", "resource-aware results", "appendix-aware paper"],
    section_headings: ["Introduction", "Related Work", "Method", "Results", "Discussion", "Limitations", "Conclusion"],
    key_claim_themes: ["The declared primary comparison shows a bounded outcome difference under repeated evaluation."],
    citation_plan: ["paper_1", "paper_2", "paper_3"]
  });
  const sharedParagraph =
    "The manuscript keeps claims scoped to the available repeated-evaluation artifacts while describing protocol choices, resource measurements, and scope-specific behavior in enough detail for a full paper.";
  const draft = JSON.stringify({
    title: "Repeated Workflow Evaluation",
    abstract: "A richer workflow-evaluation manuscript with appendix-aware reporting.",
    keywords: ["workflow evaluation", "result traceability", "reproducibility"],
    sections: [
      {
        heading: "Introduction",
        paragraphs: [
          "We study role-bound result reporting under a constrained execution budget.",
          sharedParagraph
        ],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1", "paper_2"]
      },
      {
        heading: "Related Work",
        paragraphs: [
          "Prior work spans explicit result schemas, repeated evaluation protocols, and evidence-grounded scientific reporting.",
          "The closest prior work separates these concerns, while the present study evaluates their interaction under one declared comparison."
        ],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1", "paper_2", "paper_3"]
      },
      {
        heading: "Method",
        paragraphs: [
          "The protocol compares Evaluated workflow (primary role) with Reference workflow (baseline role) on evaluation_suite under the held-out partition.",
          "Preprocessing is fit within each fold, and repeated stratified evaluations use fixed seeds with outer evaluation and inner selection loops.",
          "Runtime and peak memory are recorded alongside the primary outcome under the same execution budget.",
          sharedParagraph
        ],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1", "paper_2"]
      },
      {
        heading: "Results",
        paragraphs: [
          "The declared primary comparison yields a small subject-minus-reference outcome difference.",
          "Scope-specific behavior varies, so the study reports an interval, runtime, and memory together with the primary outcome.",
          sharedParagraph
        ],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1", "paper_3"]
      },
      {
        heading: "Discussion",
        paragraphs: [
          "The outcome is best framed as a bounded workflow evaluation rather than a broad method claim.",
          sharedParagraph
        ],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_3"]
      },
      {
        heading: "Limitations",
        paragraphs: ["The evaluation scope is narrow, and repeated measurements do not justify universal inferential language."],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_3"]
      },
      {
        heading: "Conclusion",
        paragraphs: ["The paper keeps its central comparison in the main body while routing detailed repeat-level evidence to the appendix."],
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1", "paper_2", "paper_3"]
      }
    ],
    claims: [
      {
        claim_id: "c1",
        statement: "The declared primary comparison shows a bounded outcome difference under repeated evaluation.",
        section_heading: "Results",
        evidence_ids: ["ev_1"],
        citation_paper_ids: ["paper_1", "paper_3"]
      }
    ]
  });
  const review = JSON.stringify({
    summary: "The draft is grounded and uses the appendix appropriately.",
    revision_notes: ["Keep the discussion cautious and preserve the main-body comparison table."],
    unsupported_claims: [],
    missing_sections: [],
    missing_citations: []
  });
  const manuscript = JSON.stringify({
    title: "Repeated Workflow Evaluation",
    abstract: "A richer workflow-evaluation manuscript with appendix-aware reporting.",
    keywords: ["workflow evaluation", "result traceability", "reproducibility"],
    sections: [
      {
        heading: "Introduction",
        paragraphs: [
          "We study role-bound result reporting under a constrained execution budget.",
          sharedParagraph
        ]
      },
      {
        heading: "Related Work",
        paragraphs: [
          "Prior work spans explicit result schemas, repeated evaluation protocols, and evidence-grounded scientific reporting.",
          "The closest prior work separates these concerns, while the present study evaluates their interaction under one declared comparison."
        ]
      },
      {
        heading: "Method",
        paragraphs: [
          "The protocol compares Evaluated workflow (primary role) with Reference workflow (baseline role) on evaluation_suite under the held-out partition.",
          "Preprocessing is fit within each fold, and repeated stratified evaluations use fixed seeds with outer evaluation and inner selection loops.",
          "Runtime and peak memory are recorded alongside the primary outcome under the same execution budget.",
          sharedParagraph
        ]
      },
      {
        heading: "Results",
        paragraphs: [
          "The declared primary comparison yields a small subject-minus-reference outcome difference.",
          "Scope-specific behavior varies, so the study reports an interval, runtime, and memory together with the primary outcome.",
          sharedParagraph
        ]
      },
      {
        heading: "Discussion",
        paragraphs: [
          "The outcome is best framed as a bounded workflow evaluation rather than a broad method claim.",
          sharedParagraph
        ]
      },
      {
        heading: "Limitations",
        paragraphs: ["The evaluation scope is narrow, and repeated measurements do not justify universal inferential language."]
      },
      {
        heading: "Conclusion",
        paragraphs: ["The paper keeps its central comparison in the main body while routing detailed repeat-level evidence to the appendix."]
      }
    ]
  });
  return [outline, draft, review, manuscript];
}

function buildInconsistentScientificResponses(): string[] {
  const base = buildMediumScientificResponses();
  const inconsistentManuscript = JSON.stringify({
    title: "Repeated Workflow Evaluation",
    abstract: "The Outcome score difference is 0.20 points across 8 repeated evaluations.",
    keywords: ["workflow evaluation", "result traceability", "reproducibility"],
    sections: [
      {
        heading: "Introduction",
        paragraphs: ["We study role-bound result reporting under a constrained execution budget."]
      },
      {
        heading: "Method",
        paragraphs: [
          "The protocol uses 3 repeated evaluations with an outer five-fold loop and an inner three-fold loop. Evaluated workflow (primary role) and Reference workflow (baseline role) use the same setup."
        ]
      },
      {
        heading: "Results",
        paragraphs: ["The Outcome score difference is 0.05 points across 2 repeated evaluations."]
      },
      {
        heading: "Conclusion",
        paragraphs: ["The Outcome score difference is 0.30 points across 8 repeated evaluations."]
      }
    ]
  });
  return [...base.slice(0, 3), inconsistentManuscript];
}

function buildMediumResultAnalysis(): Record<string, unknown> {
  const contract = buildResultsContractFixture({ includeResourceMetrics: true });
  return {
    analysis_version: 1,
    ...contract,
    objective_metric: {
      evaluation: {
        summary: "The declared primary comparison shows a small positive outcome difference."
      },
      profile: {
        preferred_metric_keys: [PRIMARY_METRIC_ID]
      }
    },
    metric_table: [
      { key: PRIMARY_METRIC_ID, value: 0.05 },
      { key: "pairwise_agreement", value: 0.885 },
      { key: "runtime_seconds", value: 1.05 },
      { key: "peak_memory_mb", value: 149 },
      { key: "sample_count", value: 240 }
    ],
    primary_findings: [
      "The declared primary comparison shows a small positive outcome difference.",
      "Runtime and memory remain close across the compared workflows."
    ],
    limitations: [
      "The observed difference is small and limited to the declared evaluation scope.",
      "Repeated measurements do not justify universal inferential language."
    ],
    statistical_summary: {
      executed_trials: 6,
      total_trials: 6,
      notes: [
        "Dispersion across repeated evaluations is moderate rather than negligible.",
        "Scope-specific heterogeneity remains visible."
      ],
      confidence_intervals: [
        {
          metric_key: PRIMARY_METRIC_ID,
          label: "Outcome score difference",
          lower: 0.02,
          upper: 0.08,
          level: 0.95,
          source: "results_artifact",
          summary: "The 95% interval for the outcome difference spans 0.02 to 0.08 points."
        }
      ],
      effect_estimates: [
        {
          comparison_id: PRIMARY_COMPARISON_ID,
          metric_key: PRIMARY_METRIC_ID,
          delta: 0.05,
          direction: "positive",
          summary: "The estimated outcome difference remains positive but modest."
        }
      ]
    },
    figure_specs: [
      {
        id: "primary-outcome-overview",
        title: "Declared outcome comparison",
        path: "figures/primary-outcome.svg",
        metric_keys: [PRIMARY_METRIC_ID],
        summary: "The declared primary outcome with uncertainty-aware interpretation."
      }
    ],
    synthesis: {
      source: "fallback",
      discussion_points: [
        "The observed difference supports a bounded evaluation claim rather than a broad method claim."
      ],
      failure_analysis: [],
      follow_up_actions: [],
      confidence_statement: "Confidence is moderate because repeated evaluations exist, but the declared scope remains narrow."
    }
  };
}

function buildMediumLatestResults(): Record<string, unknown> {
  return {
    protocol: {
      dataset_source: "fixture registry",
      datasets: ["evaluation_suite"],
      workflows: ["evaluated_workflow", "reference_workflow"],
      repeats: 3,
      seed_schedule: [100, 101, 102],
      n_samples: 240,
      n_features: 12,
      n_classes: 3
    },
    dataset_summaries: [
      {
        dataset: "evaluation_suite",
        observations: [
          { series_id: SUBJECT_SERIES_ID, metric_id: PRIMARY_METRIC_ID, value: 0.76 },
          { series_id: REFERENCE_SERIES_ID, metric_id: PRIMARY_METRIC_ID, value: 0.71 }
        ],
        runtime_seconds_mean: 1.05,
        peak_memory_mb_mean: 149
      }
    ],
    repeat_records: [
      { repeat_index: 0, seed: 100, comparison_id: PRIMARY_COMPARISON_ID },
      { repeat_index: 1, seed: 101, comparison_id: PRIMARY_COMPARISON_ID },
      { repeat_index: 2, seed: 102, comparison_id: PRIMARY_COMPARISON_ID }
    ]
  };
}

async function seedMediumScientificRun(run: RunRecord): Promise<void> {
  await overwriteRunArtifacts(run, {
    "paper_summaries.jsonl": [
      {
        paper_id: "paper_1",
        title: "Role-Bound Result Schemas",
        source_type: "full_text",
        summary: "Explicit series roles and observation links make quantitative comparisons auditable.",
        key_findings: ["Role-bound comparisons resist label- and order-based inference."],
        limitations: ["Schema validity does not establish empirical generality."],
        datasets: ["evaluation_suite"],
        metrics: [PRIMARY_METRIC_ID],
        novelty: "Explicit comparison semantics",
        reproducibility_notes: ["Series roles, scopes, and evidence references are reported."]
      },
      {
        paper_id: "paper_2",
        title: "Repeated Evaluation Protocols",
        source_type: "full_text",
        summary: "Repeated evaluation supports cautious interpretation of bounded workflow comparisons.",
        key_findings: ["Fixed seeds and nested selection expose outcome variability."],
        limitations: ["Repeated evaluation does not imply broad transfer."],
        datasets: ["evaluation_suite"],
        metrics: [PRIMARY_METRIC_ID, "runtime_seconds", "peak_memory_mb"],
        novelty: "Resource-aware repeated evaluation",
        reproducibility_notes: ["Seeds, loops, runtime, and memory are listed."]
      },
      {
        paper_id: "paper_3",
        title: "Evidence-Grounded Scientific Reporting",
        source_type: "full_text",
        summary: "Primary claims should remain linked to explicit artifacts and conservative scope statements.",
        key_findings: ["Claim ceilings reduce unsupported generalization."],
        limitations: ["Reporting discipline cannot replace broader experiments."],
        datasets: ["evaluation_suite"],
        metrics: [PRIMARY_METRIC_ID],
        novelty: "Traceable claim-to-evidence reporting",
        reproducibility_notes: ["Intervals and scope limitations are emphasized."]
      }
    ].map((row) => JSON.stringify(row)).join("\n") + "\n",
    "corpus.jsonl": [
      {
        paper_id: "paper_1",
        title: "Role-Bound Result Schemas",
        abstract: "Explicit series roles and observation links make quantitative comparisons auditable.",
        authors: ["Alice Doe"],
        year: 2025,
        venue: "ACL Findings"
      },
      {
        paper_id: "paper_2",
        title: "Repeated Evaluation Protocols",
        abstract: "Repeated evaluation supports cautious interpretation of bounded workflow comparisons.",
        authors: ["Bob Doe"],
        year: 2024,
        venue: "EMNLP"
      },
      {
        paper_id: "paper_3",
        title: "Evidence-Grounded Scientific Reporting",
        abstract: "Primary claims should remain linked to explicit artifacts and conservative scope statements.",
        authors: ["Cara Doe"],
        year: 2024,
        venue: "TMLR"
      }
    ].map((row) => JSON.stringify(row)).join("\n") + "\n",
    "experiment_plan.yaml": [
      "selected_design:",
      '  title: "Repeated configured workflow comparison"',
      "  datasets:",
      '    - "evaluation_suite"',
      "  metrics:",
      "    - " + JSON.stringify(PRIMARY_METRIC_ID),
      '    - "runtime_seconds"',
      '    - "peak_memory_mb"',
      "  baselines:",
      '    - "Reference workflow"',
      "  implementation_notes:",
      '    - "The fixture registry supplies 240 samples, 12 features, and 3 classes."',
      '    - "Normalize numeric inputs, impute missing values, and fit preprocessing within each fold."',
      '    - "Class imbalance and missingness are tracked explicitly."',
      "  evaluation_steps:",
      '    - "Run an outer five-fold evaluation with an inner three-fold selection loop."',
      '    - "Use stratified splits and repeat each workflow across fixed random seeds."',
      "  resource_notes:",
      '    - "The hyperparameter search space includes a configured depth and iteration budget."'
    ].join("\n"),
    "result_analysis.json": JSON.stringify(buildMediumResultAnalysis(), null, 2) + "\n"
  });
  await writeLatestResults(run, buildMediumLatestResults());
}

function createPdfBuildAci(options?: {
  failFirstCompile?: boolean;
  failAllCompiles?: boolean;
  failFigureRender?: boolean;
  pdfPageCount?: number;
  pdfText?: string;
}) {
  const commands: string[] = [];
  let firstCompileFailed = false;

  return {
    commands,
    api: {
      async runCommand(command: string, cwd?: string) {
        commands.push(command);
        if (!cwd) {
          throw new Error("Expected cwd for paper compilation.");
        }
        if (command === "python3 render_paper_figures.py") {
          if (options?.failFigureRender) {
            return {
              status: "error" as const,
              stdout: "",
              stderr: "figure render aborted",
              exit_code: 1,
              duration_ms: 3
            };
          }
          await writeFile(path.join(cwd, "main-result-figure-1.pdf"), "%PDF-1.4 mock figure\n", "utf8");
          return {
            status: "ok" as const,
            stdout: "rendered 1 figure",
            stderr: "",
            exit_code: 0,
            duration_ms: 3
          };
        }
        if (options?.failAllCompiles && command.startsWith("pdflatex")) {
          return {
            status: "error" as const,
            stdout: "",
            stderr: "main.tex:42: Undefined control sequence \\badcommand",
            exit_code: 1,
            duration_ms: 5
          };
        }
        if (options?.failFirstCompile && !firstCompileFailed && command.startsWith("pdflatex")) {
          firstCompileFailed = true;
          return {
            status: "error" as const,
            stdout: "",
            stderr: "main.tex:42: Undefined control sequence \\badcommand",
            exit_code: 1,
            duration_ms: 5
          };
        }
        if (command.startsWith("pdflatex")) {
          await writeFile(path.join(cwd, "main.pdf"), "%PDF-1.4 mock\n", "utf8");
          return {
            status: "ok" as const,
            stdout: "Output written on main.pdf",
            stderr: "",
            exit_code: 0,
            duration_ms: 5
          };
        }
        if (command === "bibtex main") {
          return {
            status: "ok" as const,
            stdout: "This is BibTeX, Version 0.99d",
            stderr: "",
            exit_code: 0,
            duration_ms: 2
          };
        }
        if (command === "pdfinfo main.pdf") {
          return {
            status: "ok" as const,
            stdout: `Title: mock\nPages: ${options?.pdfPageCount ?? 8}\n`,
            stderr: "",
            exit_code: 0,
            duration_ms: 1
          };
        }
        if (command === "pdftotext -layout main.pdf -") {
          const pageCount = options?.pdfPageCount ?? 8;
          const pages = Array.from({ length: Math.max(0, pageCount) }, (_, index) =>
            `Main body page ${index + 1}`
          );
          return {
            status: "ok" as const,
            stdout: options?.pdfText ?? pages.join("\f"),
            stderr: "",
            exit_code: 0,
            duration_ms: 1
          };
        }
        return {
          status: "error" as const,
          stdout: "",
          stderr: `Unexpected command: ${command}`,
          exit_code: 1,
          duration_ms: 1
        };
      }
    }
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("writePaper PDF build", () => {
  it("blocks a bounded topic-probe parent before loading any paper bundle", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-paper-bounded-parent-"));
    process.chdir(root);
    const run = makeRun("run-bounded-parent");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(path.join(runDir, "brief"), { recursive: true });
    await mkdir(path.join(runDir, "hypothesis_generation"), { recursive: true });
    await writeFile(
      path.join(runDir, "memory", "run_context.json"),
      JSON.stringify({
        version: 1,
        items: [{
          key: "run_brief.raw",
          value: "# Research Brief\n\n## Research Mode\ntopic_discovery\n\n## Topic\nBounded search."
        }]
      }),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "brief", "source_brief.md"),
      "# Research Brief\n\n## Research Mode\ntopic_discovery\n\n## Topic\nBounded search.\n",
      "utf8"
    );
    await writeFile(
      path.join(runDir, "hypothesis_generation", "topic_portfolio.json"),
      "{}\n",
      "utf8"
    );
    const node = createWritePaperNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      pdfTextLlm: {} as any,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("bounded_probe_parent_cannot_draft_paper");
    await expect(access(path.join(runDir, "paper", "input_validation.json"))).rejects.toThrow();
  });

  it("replaces authored visuals with the declared V2 primary comparison", () => {
    const contract = buildResultsContractFixture();
    const manuscript: PaperManuscript = {
      title: "Declared Comparison Study",
      abstract: "An authored summary contains an unverified directional claim.",
      keywords: ["comparison reporting"],
      sections: [
        { heading: "Method", paragraphs: ["The comparison protocol is fixed before execution."] },
        { heading: "Results", paragraphs: ["The authored ranking claims a leading series without explicit links."] }
      ],
      tables: [
        {
          caption: "Authored summary mixing outcome and coverage counts.",
          rows: [
            { label: "Unverified outcome", value: 0.99 },
            { label: "Coverage count", value: 288 }
          ]
        }
      ],
      figures: [
        {
          caption: "Authored ranking without comparison metadata.",
          bars: [
            { label: "Unverified leader", value: 0.99 },
            { label: "Unverified reference", value: 0.2 }
          ]
        }
      ]
    };

    const stabilized = stabilizePaperManuscriptForSubmission(manuscript, {
      resultsArtifact: contract.results_artifact,
      resultsPlan: contract.results_plan
    });

    expect(stabilized.tables).toHaveLength(1);
    expect(stabilized.tables?.[0]?.caption).toContain(`Declared primary comparison for ${PRIMARY_METRIC_LABEL}`);
    expect(stabilized.tables?.[0]?.rows).toMatchObject([
      {
        label: "Evaluated workflow (primary role, subject)",
        comparison_id: PRIMARY_COMPARISON_ID,
        observation_id: SUBJECT_OBSERVATION_ID,
        metric_id: PRIMARY_METRIC_ID,
        series_id: SUBJECT_SERIES_ID,
        series_role: "primary",
        comparison_side: "subject"
      },
      {
        label: "Reference workflow (baseline role, reference)",
        observation_id: REFERENCE_OBSERVATION_ID,
        series_role: "baseline",
        comparison_side: "reference"
      },
      {
        label: "Subject-minus-reference difference",
        comparison_side: "difference"
      }
    ]);
    expect(stabilized.figures?.[0]?.bars).toMatchObject([
      { observation_id: SUBJECT_OBSERVATION_ID, comparison_side: "subject" },
      { observation_id: REFERENCE_OBSERVATION_ID, comparison_side: "reference" }
    ]);
    expect(stabilized.tables?.[0]?.source_refs).toEqual(
      expect.arrayContaining([{ kind: "artifact", id: DERIVED_MAIN_TABLE_SOURCE_REF_ID }])
    );
    expect(stabilized.figures?.[0]?.source_refs).toEqual(
      expect.arrayContaining([{ kind: "artifact", id: DERIVED_MAIN_FIGURE_SOURCE_REF_ID }])
    );
    expect(JSON.stringify(stabilized)).not.toMatch(/Coverage count|Unverified leader/iu);
  });

  it("uses complete V2 evidence while dropping repair-note appendix sections", () => {
    const contract = buildResultsContractFixture();
    const manuscript: PaperManuscript = {
      title: "Declared Comparison Study",
      abstract: "A bounded comparison is backed by explicit observations.",
      keywords: ["comparison reporting"],
      sections: [
        { heading: "Method", paragraphs: ["The protocol declares subject and reference roles."] },
        { heading: "Results", paragraphs: ["The result is reported from linked observations."] }
      ],
      appendix_sections: [
        {
          heading: "Recommended Additions for a Complete Reproducibility Appendix",
          paragraphs: ["The available package should include more internal fields."]
        },
        {
          heading: "Recommended Follow-up Reporting",
          paragraphs: ["A future revision should explain the internal repair process."]
        },
        {
          heading: "Supplementary Protocol",
          paragraphs: ["The executed protocol exposes repeated-measure details for reader inspection."]
        }
      ]
    };

    const stabilized = stabilizePaperManuscriptForSubmission(manuscript, {
      resultsArtifact: contract.results_artifact,
      resultsPlan: contract.results_plan
    });

    expect(stabilized.tables?.[0]?.rows).toHaveLength(3);
    expect(stabilized.figures?.[0]?.bars).toHaveLength(2);
    expect(stabilized.appendix_sections?.map((section) => section.heading)).toEqual([
      "Supplementary Protocol"
    ]);
  });

  it("dedupes repeated related-work axis paragraphs during manuscript stabilization", () => {
    const stabilized = stabilizePaperManuscriptForSubmission({
      title: "Configured Evaluation Study",
      abstract: "A bounded comparison is reported under a fixed protocol.",
      keywords: ["workflow evaluation"],
      sections: [
        {
          heading: "Related Work",
          paragraphs: [
            "A first strand studies explicit result schemas and comparison provenance.",
            "A second strand studies evaluation protocols and bounded empirical claims.",
            "A third strand is resource awareness. Budget-constrained evaluation motivates reporting outcome, runtime, and memory together.",
            "A third strand is resource awareness. Resource-conscious evaluation motivates joint reporting of outcome, runtime, and memory."
          ]
        },
        {
          heading: "Method",
          paragraphs: ["The method evaluates a declared subject and reference under one fixed protocol."]
        }
      ],
      tables: [],
      figures: []
    });

    const related = stabilized.sections.find((section) => section.heading === "Related Work");
    expect(related?.paragraphs.filter((paragraph) => /\bthird strand\b/iu.test(paragraph))).toHaveLength(1);
  });

  it("removes draft-facing citation and reporting instructions from reader sections", () => {
    const stabilized = stabilizePaperManuscriptForSubmission({
      title: "Configured Evaluation Study",
      abstract: "A bounded comparison reports one declared outcome.",
      keywords: [],
      sections: [
        {
          heading: "Method",
          paragraphs: ["The executed protocol uses fixed preprocessing and evaluation settings."]
        },
        {
          heading: "Limitations",
          paragraphs: [
            "Several related-work notes available to this draft are not validated. The final manuscript should cite stable sources for the evaluation protocol.",
            "The available summary does not expose complete resource traces, so resource-efficiency claims remain outside the evidence ceiling."
          ]
        }
      ],
      appendix_sections: [
        {
          heading: "Supplementary Reporting Requirements for Replication",
          paragraphs: [
            "The final analysis should make clear how intervals are computed. The protocol record lists planned execution counts."
          ]
        }
      ],
      tables: [],
      figures: []
    });

    const text = JSON.stringify(stabilized);
    expect(text).not.toMatch(/available to this draft|final manuscript should cite|stable sources/iu);
    expect(text).not.toMatch(/final analysis should make clear/iu);
    expect(text).toContain("resource-efficiency claims remain outside the evidence ceiling");
    expect(text).toContain("protocol record lists planned execution counts");
  });

  it("replaces provided summary rows with explicit V2 observation links", () => {
    const contract = buildResultsContractFixture();
    const manuscript: PaperManuscript = {
      title: "Provided Summary Study",
      abstract: "An authored summary is reconciled with the canonical comparison.",
      keywords: ["comparison reporting"],
      sections: [
        { heading: "Method", paragraphs: ["The protocol fixes the comparison before execution."] },
        { heading: "Results", paragraphs: ["Table 1 presents the declared comparison."] }
      ],
      tables: [
        {
          caption: "Provided summary in display order.",
          rows: [
            { label: "Reference shown first", value: 0.71 },
            { label: "Subject shown second", value: 0.76 }
          ]
        }
      ],
      figures: []
    };

    const stabilized = stabilizePaperManuscriptForSubmission(manuscript, {
      resultsArtifact: contract.results_artifact,
      resultsPlan: contract.results_plan
    });
    const rows = stabilized.tables?.[0]?.rows || [];

    expect(rows.map((row) => row.comparison_side)).toEqual(["subject", "reference", "difference"]);
    expect(rows[0]).toMatchObject({
      value: 0.76,
      series_id: SUBJECT_SERIES_ID,
      series_role: "primary",
      observation_id: SUBJECT_OBSERVATION_ID
    });
    expect(rows[1]).toMatchObject({
      value: 0.71,
      series_id: REFERENCE_SERIES_ID,
      series_role: "baseline",
      observation_id: REFERENCE_OBSERVATION_ID
    });
    expect(rows[2]).toMatchObject({
      value: expect.closeTo(0.05, 10),
      comparison_id: PRIMARY_COMPARISON_ID,
      metric_id: PRIMARY_METRIC_ID
    });
    expect(rows.map((row) => row.label).join(" ")).not.toContain("shown first");
  });

  it("uses fixture-supplied metric and series labels on reader-facing visuals", () => {
    const contract = buildResultsContractFixture({
      metricId: "declared_measure",
      metricLabel: "Declared measure",
      subjectLabel: "Candidate workflow",
      referenceLabel: "Control workflow",
      subjectValue: 12,
      referenceValue: 15,
      direction: "lower_better",
      unit: "units"
    });

    const stabilized = stabilizePaperManuscriptForSubmission({
      title: "Reader-Facing Comparison",
      abstract: "A configured comparison uses labels supplied by its result contract.",
      keywords: [],
      sections: [{ heading: "Results", paragraphs: ["The linked observations determine the display."] }]
    }, {
      resultsArtifact: contract.results_artifact,
      resultsPlan: contract.results_plan
    });

    expect(stabilized.tables?.[0]?.caption).toContain("Declared measure under Partition=held-out partition");
    expect(stabilized.tables?.[0]?.caption).toContain("lower values preferred");
    expect(stabilized.tables?.[0]?.rows.map((row) => row.label)).toEqual([
      "Candidate workflow (primary role, subject)",
      "Control workflow (baseline role, reference)",
      "Subject-minus-reference difference"
    ]);
    expect(stabilized.figures?.[0]?.caption).toContain("Declared measure under Partition=held-out partition");
  });

  it("preserves declared roles without inferring them from labels, order, or values", () => {
    const contract = buildResultsContractFixture({
      subjectLabel: "Configured subject",
      referenceLabel: "Declared baseline",
      subjectValue: 12,
      referenceValue: 9,
      direction: "lower_better",
      unit: "units"
    });
    contract.results_artifact.series.reverse();
    contract.results_artifact.observations.reverse();

    const manuscript: PaperManuscript = {
      title: "Role-Bound Comparison",
      abstract: "The display follows explicit links rather than observed ranking.",
      keywords: [],
      sections: [
        { heading: "Method", paragraphs: ["Roles and scope are declared before execution."] },
        { heading: "Results", paragraphs: ["The primary comparison remains role-bound."] }
      ],
      tables: [
        {
          caption: "Stale derived table.",
          rows: [{ label: "Incorrect inferred winner", value: 9 }],
          source_refs: [{ kind: "artifact", id: DERIVED_MAIN_TABLE_SOURCE_REF_ID }]
        }
      ],
      figures: []
    };

    const stabilized = stabilizePaperManuscriptForSubmission(manuscript, {
      resultsArtifact: contract.results_artifact,
      resultsPlan: contract.results_plan
    });
    const rows = stabilized.tables?.[0]?.rows || [];

    expect(rows[0]).toMatchObject({
      label: "Configured subject (primary role, subject)",
      value: 12,
      comparison_side: "subject"
    });
    expect(rows[1]).toMatchObject({
      label: "Declared baseline (baseline role, reference)",
      value: 9,
      comparison_side: "reference"
    });
    expect(rows[2]).toMatchObject({ value: 3, comparison_side: "difference" });
    expect(stabilized.figures?.[0]?.bars.map((row) => row.comparison_side)).toEqual([
      "subject",
      "reference"
    ]);
    expect(JSON.stringify(stabilized)).not.toContain("Incorrect inferred winner");

    const restabilized = stabilizePaperManuscriptForSubmission(stabilized, {
      resultsArtifact: contract.results_artifact,
      resultsPlan: contract.results_plan
    });
    expect(restabilized.tables?.[0]?.rows.map((row) => row.comparison_side)).toEqual([
      "subject",
      "reference",
      "difference"
    ]);
    expect(restabilized.figures?.[0]?.source_refs).toEqual(
      expect.arrayContaining([{ kind: "artifact", id: DERIVED_MAIN_FIGURE_SOURCE_REF_ID }])
    );
  });

  it("runs a related-work scout and allows the writer to cite scout-only papers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-paper-related-work-scout-"));
    process.chdir(root);

    const run = makeRun("run-paper-related-work-scout");
    const runDir = await seedRun(root, run);
    const requests: Array<{ query: string; limit: number }> = [];
    const semanticScholar = {
      async searchPapers(request: { query: string; limit: number }) {
        requests.push({ query: request.query, limit: request.limit });
        const paperIndex = requests.length;
        return [
          {
            paperId: `paper_scout_${paperIndex}`,
            title: paperIndex === 1 ? "Scout Results for Related Work" : "Coverage Backfill for Related Work",
            abstract: "A lightweight scouting pass can expand related-work coverage during drafting.",
            year: 2024,
            venue: paperIndex === 1 ? "EMNLP" : "NAACL",
            authors: ["Sam Scout"],
            citationCount: 17 + paperIndex,
            url: `https://example.org/scout-results-${paperIndex}`,
            openAccessPdfUrl: `https://example.org/scout-results-${paperIndex}.pdf`
          }
        ];
      }
    };

    const node = createWritePaperNode({
      config: {
        providers: {
          llm_mode: "openai_api"
        },
        paper: {
          build_pdf: false
        },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildRelatedWorkScoutResponses()),
      pdfTextLlm: {} as any,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: semanticScholar as any,
      responsesPdfAnalysis: {
        hasApiKey: async () => true,
        analyzePdf: async ({ pdfUrl }: { pdfUrl: string }) => ({
          text: JSON.stringify({
            summary: `Full-text summary for ${pdfUrl}.`,
            key_findings: ["Full-text related-work analysis recovered a grounded positioning signal."],
            limitations: ["The PDF analysis focuses on related-work positioning rather than experimental reproduction."],
            datasets: ["evaluation_suite"],
            metrics: [PRIMARY_METRIC_ID],
            novelty: "Full-text scout enrichment for related work",
            reproducibility_notes: ["The PDF source was read directly during write_paper."],
            evidence_items: [
              {
                claim: "The paper frames the primary outcome through explicit comparison semantics.",
                method_slot: "related-work framing",
                result_slot: "positioning evidence",
                limitation_slot: "bounded enrichment",
                dataset_slot: "evaluation_suite",
                metric_slot: PRIMARY_METRIC_ID,
                evidence_span: "The full paper highlights explicit outcome links and bounded comparison scope.",
                confidence: 0.78,
                confidence_reason: "The enrichment is grounded in the full PDF input."
              }
            ]
          })
        })
      } as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    expect(requests).toHaveLength(2);
    expect(requests[0]?.query).toContain("configured workflow evaluation");
    expect(requests[0]?.query).toContain("Configured workflow comparison");
    expect(requests[1]?.query).toContain("configured workflow evaluation");

    const scoutRequest = JSON.parse(
      await readFile(path.join(runDir, "paper", "related_work_scout", "request.json"), "utf8")
    ) as { query: string; planned_queries: Array<{ id: string }> };
    expect(scoutRequest.query).toContain("configured workflow evaluation");
    expect(scoutRequest.planned_queries.length).toBeGreaterThanOrEqual(2);

    const scoutPlan = JSON.parse(
      await readFile(path.join(runDir, "paper", "related_work_scout", "plan.json"), "utf8")
    ) as { planned_queries: Array<{ id: string }> };
    expect(scoutPlan.planned_queries.length).toBeGreaterThanOrEqual(2);

    const scoutResult = JSON.parse(
      await readFile(path.join(runDir, "paper", "related_work_scout", "result.json"), "utf8")
    ) as { status: string; paper_count: number };
    expect(scoutResult).toMatchObject({
      status: "collected",
      paper_count: 2
    });

    const coverageAudit = JSON.parse(
      await readFile(path.join(runDir, "paper", "related_work_scout", "coverage_audit.json"), "utf8")
    ) as { status: string; executed_queries: Array<{ query: string }>; stop_reason: string };
    expect(coverageAudit.status).toBe("sufficient");
    expect(coverageAudit.executed_queries).toHaveLength(2);
    expect(coverageAudit.stop_reason).toMatch(/venue diversity|citation gap|target additional paper count/i);

    expect(await exists(path.join(runDir, "paper", "related_work_scout", "corpus.jsonl"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "related_work_scout", "bibtex.bib"))).toBe(true);
    const enrichmentResult = JSON.parse(
      await readFile(path.join(runDir, "paper", "related_work_scout", "enrichment_result.json"), "utf8")
    ) as { status: string; analyzed_paper_count: number; full_text_count: number };
    expect(enrichmentResult).toMatchObject({
      status: "completed",
      analyzed_paper_count: 2,
      full_text_count: 2
    });
    const enrichmentSummaries = await readFile(
      path.join(runDir, "paper", "related_work_scout", "enrichment_summaries.jsonl"),
      "utf8"
    );
    expect(enrichmentSummaries).toContain('"paper_id":"paper_scout_1"');
    expect(enrichmentSummaries).toContain('"source_type":"full_text"');

    const relatedWorkNotes = JSON.parse(
      await readFile(path.join(runDir, "paper", "related_work_notes.json"), "utf8")
    ) as { note_count: number; comparison_axes: string[]; paragraph_plan: Array<{ role: string }> };
    expect(relatedWorkNotes.note_count).toBeGreaterThanOrEqual(3);
    expect(relatedWorkNotes.comparison_axes.length).toBeGreaterThan(0);
    expect(relatedWorkNotes.paragraph_plan).toHaveLength(2);

    const draft = JSON.parse(await readFile(path.join(runDir, "paper", "draft.json"), "utf8")) as {
      sections: Array<{ heading: string; paragraphs: Array<{ text: string }>; citation_paper_ids: string[] }>;
    };
    const relatedWorkSection = draft.sections.find((section) => section.heading === "Related Work");
    expect(relatedWorkSection?.citation_paper_ids).toContain("paper_scout_1");
    expect(relatedWorkSection?.paragraphs.length).toBeGreaterThanOrEqual(2);
    expect(relatedWorkSection?.paragraphs.some((paragraph) => /current study|present study/i.test(paragraph.text))).toBe(true);

    const references = await readFile(path.join(runDir, "paper", "references.bib"), "utf8");
    expect(references).toContain("Scout Results for Related Work");
    expect(references).toContain("Coverage Backfill for Related Work");

    const memory = new RunContextMemory(run.memoryRefs.runContextPath);
    expect(await memory.get("write_paper.cited_paper_ids")).toContain("paper_scout_1");
    expect(await memory.get("write_paper.related_work_scout")).toMatchObject({
      status: "collected",
      paper_count: 2,
      planned_query_count: 3,
      executed_query_count: 2,
      coverage_status: "sufficient"
    });
    expect(await memory.get("write_paper.related_work_notes")).toMatchObject({
      note_count: 3
    });
    expect(await memory.get("write_paper.related_work_enrichment")).toMatchObject({
      analyzed_paper_count: 2,
      full_text_count: 2
    });
  });

  it("recovers missing citations through bounded external verification before building references", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-paper-external-citation-"));
    process.chdir(root);

    const run = makeRun("run-paper-external-citation");
    const runDir = await seedRun(root, run);
    await appendFile(
      path.join(runDir, "paper_summaries.jsonl"),
      `${JSON.stringify({
        paper_id: "Recovered External Title",
        title: "Recovered External Title",
        source_type: "full_text",
        summary: "A placeholder summary keeps the citation id alive through draft normalization.",
        key_findings: ["The missing citation should be recovered externally before bibliography generation."],
        limitations: ["This summary exists only to exercise the bounded external citation-repair path."],
        datasets: [],
        metrics: [],
        novelty: "External citation verification",
        reproducibility_notes: []
      })}\n`,
      "utf8"
    );
    const node = createWritePaperNode({
      config: {
        providers: {
          llm_mode: "openai_api"
        },
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildExternalCitationResponses()),
      pdfTextLlm: {} as any,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {
        async searchPapers(request: { query: string; limit: number }) {
          expect(request.query).toBe("Recovered External Title");
          expect(request.limit).toBe(5);
          return [
            {
              paperId: "s2_recovered_external",
              title: "Recovered External Title",
              abstract: "Recovered from bounded external verification.",
              authors: ["Eve Resolver"],
              year: 2025,
              venue: "ACL",
              doi: "10.1000/recovered-external",
              url: "https://example.org/recovered-external",
              citationStylesBibtex:
                "@article{RecoveredExternal2025,title={Recovered External Title},doi={10.1000/recovered-external},url={https://example.org/recovered-external}}"
            }
          ];
        }
      } as any,
      responsesPdfAnalysis: {
        hasApiKey: async () => false
      } as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");

    const verifiedRegistry = JSON.parse(
      await readFile(path.join(runDir, "paper", "verified_registry.json"), "utf8")
    ) as {
      counts: Record<string, number>;
      entries: Array<{
        citation_paper_id: string;
        status: string;
        resolved_via?: string;
        provider?: string;
      }>;
    };
    expect(verifiedRegistry.counts.unverified).toBe(1);
    const externalEntry = verifiedRegistry.entries.find(
      (entry) => entry.citation_paper_id === "Recovered External Title"
    );
    expect(externalEntry).toMatchObject({
      citation_paper_id: "Recovered External Title",
      status: "unverified",
      resolved_via: "external_provider",
      provider: "semantic_scholar"
    });

    const references = await readFile(path.join(runDir, "paper", "references.bib"), "utf8");
    expect(references).toContain("Recovered External Title");
    expect(references).toContain("10.1000/recovered-external");

    const readinessRisks = JSON.parse(
      await readFile(path.join(runDir, "paper", "readiness_risks.json"), "utf8")
    ) as {
      risks: Array<{ category: string; affected_citation_ids: string[]; status: string }>;
    };
    expect(readinessRisks.risks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "citation_source",
          status: "unverified",
          affected_citation_ids: ["Recovered External Title"]
        })
      ])
    );
  });

  it("runs one validation repair pass before rendering when warnings accumulate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-paper-validation-repair-"));
    process.chdir(root);

    const run = makeRun("run-paper-validation-repair");
    const runDir = await seedRun(root, run);

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildValidationRepairResponses()),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    expect(result.summary).toContain("after one automatic validation repair (1 -> 0)");

    const validation = JSON.parse(await readFile(path.join(runDir, "paper", "validation.json"), "utf8")) as {
      issues: Array<{ message: string }>;
    };
    expect(validation.issues).toHaveLength(0);

    const repairReport = JSON.parse(
      await readFile(path.join(runDir, "paper", "validation_repair_report.json"), "utf8")
    ) as {
      attempted: boolean;
      applied: boolean;
      initial_warning_count: number;
      final_warning_count: number;
    };
    expect(repairReport).toMatchObject({
      attempted: true,
      applied: true,
      initial_warning_count: 1,
      final_warning_count: 0
    });

    const traceRaw = await readFile(path.join(runDir, "paper", "session_trace.json"), "utf8");
    expect(traceRaw).toContain('"stage": "validation_repair"');

    const memory = new RunContextMemory(run.memoryRefs.runContextPath);
    expect(await memory.get("write_paper.validation_repair")).toMatchObject({
      attempted: true,
      applied: true,
      initial_warning_count: 1,
      final_warning_count: 0
    });
  });

  it("builds a paper PDF and publishes the compiled artifact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-paper-pdf-"));
    process.chdir(root);

    const run = makeRun("run-paper-pdf-success");
    const runDir = await seedRun(root, run);
    const aci = createPdfBuildAci();

    const node = createWritePaperNode({
      config: {
        paper: {
          template: "acl",
          build_pdf: true,
          latex_engine: "auto_install"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildSessionResponses()),
      codex: {} as any,
      aci: aci.api as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    expect(result.summary).toContain("PDF: built successfully");
    expect(aci.commands).toEqual([
      "python3 render_paper_figures.py",
      "pdflatex -interaction=nonstopmode -halt-on-error -file-line-error main.tex",
      "bibtex main",
      "pdflatex -interaction=nonstopmode -halt-on-error -file-line-error main.tex",
      "pdflatex -interaction=nonstopmode -halt-on-error -file-line-error main.tex",
      "pdfinfo main.pdf",
      "pdftotext -layout main.pdf -"
    ]);

    expect(await exists(path.join(runDir, "paper", "main.pdf"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "compile_report.json"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "manuscript.json"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "traceability.json"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "submission_validation.json"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "compiled_page_validation.json"))).toBe(true);
    expect(await exists(path.join(buildPublicPaperDir(root, run), "main.pdf"))).toBe(true);
    expect(await exists(path.join(buildPublicPaperDir(root, run), "build.log"))).toBe(true);
    expect(await exists(path.join(buildPublicPaperDir(root, run), "manuscript.json"))).toBe(true);
    expect(await exists(path.join(buildPublicPaperDir(root, run), "traceability.json"))).toBe(true);

    const report = JSON.parse(await readFile(path.join(runDir, "paper", "compile_report.json"), "utf8")) as {
      status: string;
      repaired: boolean;
      attempts: Array<{ status: string }>;
    };
    expect(report.status).toBe("success");
    expect(report.repaired).toBe(false);
    expect(report.attempts).toHaveLength(1);
    const submissionValidation = JSON.parse(
      await readFile(path.join(runDir, "paper", "submission_validation.json"), "utf8")
    ) as { ok: boolean; issues: unknown[] };
    expect(submissionValidation.ok).toBe(true);
    expect(submissionValidation.issues).toHaveLength(0);
    const compiledPageValidation = JSON.parse(
      await readFile(path.join(runDir, "paper", "compiled_page_validation.json"), "utf8")
    ) as {
      status: string;
      compiled_pdf_page_count: number;
      minimum_main_pages: number;
      target_main_pages: number;
      main_page_limit: number;
    };
    expect(compiledPageValidation.status).toBe("pass");
    expect(compiledPageValidation.compiled_pdf_page_count).toBe(8);
    expect(compiledPageValidation.minimum_main_pages).toBe(8);
    expect(compiledPageValidation.target_main_pages).toBe(8);
    expect(compiledPageValidation.main_page_limit).toBe(8);

    const memory = new RunContextMemory(run.memoryRefs.runContextPath);
    expect(await memory.get("write_paper.compile_status")).toBe("success");
    expect(await memory.get("write_paper.pdf_path")).toBe(
      path.join(".autolabos", "runs", run.id, "paper", "main.pdf")
    );
  });

  it("fails before LaTeX compilation when submission validation catches raw evidence ids", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-paper-submission-validation-"));
    process.chdir(root);

    const run = makeRun("run-paper-submission-validation");
    const runDir = await seedRun(root, run);
    const aci = createPdfBuildAci();

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: true
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildSubmissionValidationFailureResponses()),
      codex: {} as any,
      aci: aci.api as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("submission-quality validation failed");
    expect(result.error).toContain("raw evidence identifier");
    expect(aci.commands).toEqual(["python3 render_paper_figures.py"]);
    expect(await exists(path.join(runDir, "paper", "main.pdf"))).toBe(false);

    const submissionValidation = JSON.parse(
      await readFile(path.join(runDir, "paper", "submission_validation.json"), "utf8")
    ) as { ok: boolean; issues: Array<{ kind: string; value?: string }> };
    expect(submissionValidation.ok).toBe(false);
    expect(
      submissionValidation.issues.some(
        (issue) => issue.kind === "evidence_id" && issue.value?.includes("ev_1")
      )
    ).toBe(true);

    const memory = new RunContextMemory(run.memoryRefs.runContextPath);
    expect(await memory.get("write_paper.compile_status")).toBe(null);
    expect(await memory.get("write_paper.pdf_path")).toBe(null);
  });

  it("rejects uninformative unstructured metrics before generating paper visuals", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-paper-visual-gate-"));
    process.chdir(root);

    const run = makeRun("run-paper-visual-gate");
    const runDir = await seedRun(root, run);
    await writeFile(
      path.join(runDir, "result_analysis.json"),
      JSON.stringify(
        {
          analysis_version: 1,
          objective_metric: {
            evaluation: {
              summary: "A unstructured scalar summary is present without an explicit comparison."
            }
          },
          metric_table: [
            { key: "unstructured_summary_a.json", value: 1 },
            { key: "unstructured_summary_b.json", value: 1 },
            { key: "unstructured_summary_c.json", value: 1 }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildSessionResponses()),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("requires AnalysisReport.results_artifact V2");
    expect(await exists(path.join(runDir, "paper", "main.tex"))).toBe(false);
  });

  it("repairs LaTeX once after a failed compile and retries the PDF build", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-paper-pdf-repair-"));
    process.chdir(root);

    const run = makeRun("run-paper-pdf-repair");
    const runDir = await seedRun(root, run);
    const aci = createPdfBuildAci({ failFirstCompile: true });
    const llm = new SequencedLLMClient([
      ...buildSessionResponses(),
      "\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\nRepaired paper draft.\n\\includegraphics{figures/main-result-figure-1.pdf}\n\\end{document}\n"
    ]);

    const node = createWritePaperNode({
      config: {
        paper: {
          template: "acl",
          build_pdf: true,
          latex_engine: "auto_install"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      codex: {} as any,
      aci: aci.api as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    expect(result.summary).toContain("after one automatic repair");
    expect(aci.commands).toEqual([
      "python3 render_paper_figures.py",
      "pdflatex -interaction=nonstopmode -halt-on-error -file-line-error main.tex",
      "pdflatex -interaction=nonstopmode -halt-on-error -file-line-error main.tex",
      "bibtex main",
      "pdflatex -interaction=nonstopmode -halt-on-error -file-line-error main.tex",
      "pdflatex -interaction=nonstopmode -halt-on-error -file-line-error main.tex",
      "pdfinfo main.pdf",
      "pdftotext -layout main.pdf -"
    ]);

    const repairedTex = await readFile(path.join(runDir, "paper", "latex_repair.tex"), "utf8");
    expect(repairedTex).toContain("Repaired paper draft.");
    expect(await exists(path.join(runDir, "paper", "main.pdf"))).toBe(true);
    expect(await exists(path.join(buildPublicPaperDir(root, run), "main.pdf"))).toBe(true);
    expect(await readFile(path.join(buildPublicPaperDir(root, run), "main.tex"), "utf8")).toContain(
      "\\documentclass{article}"
    );

    const report = JSON.parse(await readFile(path.join(runDir, "paper", "compile_report.json"), "utf8")) as {
      status: string;
      repaired: boolean;
      attempts: Array<{ repaired: boolean; status: string }>;
    };
    expect(report.status).toBe("repaired_success");
    expect(report.repaired).toBe(true);
    expect(report.attempts).toHaveLength(2);
    expect(report.attempts[0]).toMatchObject({ repaired: false, status: "failed" });
    expect(report.attempts[1]).toMatchObject({ repaired: true, status: "success" });

    const memory = new RunContextMemory(run.memoryRefs.runContextPath);
    expect(await memory.get("write_paper.compile_status")).toBe("repaired_success");
    expect(await memory.get("write_paper.pdf_path")).toBe(
      path.join(".autolabos", "runs", run.id, "paper", "main.pdf")
    );
    const manifest = JSON.parse(await readFile(buildPublicRunManifestPath(root, run), "utf8")) as {
      generated_files: string[];
      sections?: {
        paper?: {
          generated_files: string[];
        };
      };
    };
    expect(manifest.generated_files).toEqual(
      expect.arrayContaining([
        "paper/main.tex",
        "paper/references.bib",
        "paper/evidence_links.json",
        "paper/claim_evidence_table.json",
        "paper/verified_registry.json",
        "paper/claim_status_table.json",
        "paper/evidence_gate_decision.json",
        "paper/paper_readiness.json",
        "paper/paper_critique.json",
        "paper/readiness_risks.json",
        "paper/main.pdf",
        "results/operator_summary.md",
        "results/run_status.json",
        "results/run_completeness_checklist.json",
        "results/operator_history/0003-paper.md"
      ])
    );
    expect(manifest.sections?.paper?.generated_files).toEqual(
      expect.arrayContaining([
        "paper/main.tex",
        "paper/references.bib",
        "paper/evidence_links.json",
        "paper/claim_evidence_table.json",
        "paper/verified_registry.json",
        "paper/claim_status_table.json",
        "paper/evidence_gate_decision.json",
        "paper/paper_readiness.json",
        "paper/paper_critique.json",
        "paper/readiness_risks.json",
        "paper/main.pdf"
      ])
    );
    const publicRunDir = buildPublicRunOutputDir(root, run);
    expect(await readFile(path.join(publicRunDir, "results", "operator_summary.md"), "utf8")).toContain(
      "Paper readiness:"
    );
    expect(await readFile(path.join(publicRunDir, "results", "operator_summary.md"), "utf8")).toContain(
      "Manuscript decision:"
    );
    expect(await readFile(path.join(runDir, "run_status.json"), "utf8")).toContain('"current_node": "write_paper"');
    expect(await readFile(path.join(runDir, "run_completeness_checklist.json"), "utf8")).toContain(
      '"validation_scope": "full_run"'
    );
    const publicRunStatus = JSON.parse(
      await readFile(path.join(publicRunDir, "results", "run_status.json"), "utf8")
    ) as { run_id: string; current_node: string; validation_scope: string };
    expect(publicRunStatus).toMatchObject({
      run_id: run.id,
      current_node: "write_paper",
      validation_scope: "full_run"
    });
    expect(await readFile(path.join(publicRunDir, "results", "run_completeness_checklist.json"), "utf8")).toContain(
      `"run_id": "${run.id}"`
    );
    expect(await readFile(path.join(publicRunDir, "results", "operator_history", "0003-paper.md"), "utf8")).toContain(
      "# Operator Stage Note"
    );
  });

  it("rejects automatic LaTeX repair output that removes an explicit ACL template", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-paper-pdf-template-repair-reject-"));
    process.chdir(root);

    await writeFile(
      path.join(root, "template.tex"),
      [
        "\\pdfoutput=1",
        "\\documentclass[11pt]{article}",
        "\\usepackage[review]{acl}",
        "\\begin{document}",
        "\\section{Introduction}",
        "\\end{document}"
      ].join("\n"),
      "utf8"
    );
    await writeFile(path.join(root, "acl.sty"), "% mock ACL style\n", "utf8");
    await writeFile(path.join(root, "acl_natbib.bst"), "ENTRY{}{}{} FUNCTION{default.type}{} READ\n", "utf8");

    const run = makeRun("run-paper-pdf-template-repair-reject");
    const runDir = await seedRun(root, run);
    const memory = new RunContextMemory(run.memoryRefs.runContextPath);
    await memory.put(
      "run_brief.raw",
      [
        "# Research Brief",
        "",
        "## Topic",
        "Template-faithful paper writing",
        "",
        "## Manuscript Template",
        "template.tex",
        "",
        "## Manuscript Authors",
        "- authors: AutoLabOS Validation Team"
      ].join("\n")
    );

    const aci = createPdfBuildAci({ failFirstCompile: true });
    const llm = new SequencedLLMClient([
      ...buildSessionResponses(),
      "\\documentclass{article}\n\\begin{document}\nTemplate-stripped repair.\n\\end{document}\n"
    ]);

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: true,
          latex_engine: "auto_install"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      codex: {} as any,
      aci: aci.api as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(await exists(path.join(runDir, "paper", "main.tex")), result.error).toBe(true);
    const tex = await readFile(path.join(runDir, "paper", "main.tex"), "utf8");
    expect(tex).toContain("\\usepackage[review]{acl}");
    expect(tex).not.toContain("Template-stripped repair.");
    expect(await readFile(path.join(runDir, "paper", "latex_repair.tex"), "utf8")).toContain(
      "Template-stripped repair."
    );
    const report = JSON.parse(await readFile(path.join(runDir, "paper", "compile_report.json"), "utf8")) as {
      status: string;
      repaired: boolean;
      repair_error?: string;
      warnings: string[];
    };
    expect(report.status).toBe("failed");
    expect(report.repaired).toBe(false);
    expect(report.repair_error).toContain("latex repair would remove requested template surface");
    expect(report.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("\\usepackage[review]{acl}")])
    );
  });

  it("warns in default mode when the compiled PDF remains below main_page_limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-paper-pdf-short-default-"));
    process.chdir(root);

    const run = makeRun("run-paper-pdf-short-default");
    const runDir = await seedRun(root, run);
    const aci = createPdfBuildAci({ pdfPageCount: 3 });

    const node = createWritePaperNode({
      config: {
        paper: {
          template: "acl",
          build_pdf: true,
          validation_mode: "default"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildSessionResponses()),
      codex: {} as any,
      aci: aci.api as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    const compiledPageValidation = JSON.parse(
      await readFile(path.join(runDir, "paper", "compiled_page_validation.json"), "utf8")
    ) as {
      status: string;
      outcome: string;
      compiled_pdf_page_count: number;
      minimum_main_pages: number;
      target_main_pages: number;
      main_page_limit: number;
      message: string;
    };
    expect(compiledPageValidation.status).toBe("warn");
    expect(compiledPageValidation.outcome).toBe("under_limit");
    expect(compiledPageValidation.compiled_pdf_page_count).toBe(3);
    expect(compiledPageValidation.minimum_main_pages).toBe(8);
    expect(compiledPageValidation.target_main_pages).toBe(8);
    expect(compiledPageValidation.main_page_limit).toBe(8);
    expect(compiledPageValidation.message).toContain("below the configured minimum_main_pages");
    expect(await exists(path.join(buildPublicPaperDir(root, run), "compiled_page_validation.json"))).toBe(true);
  });

  it("fails compiled page-budget validation in strict-paper mode when the PDF remains below main_page_limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-paper-pdf-short-strict-"));
    process.chdir(root);

    const run = makeRun("run-paper-pdf-short-strict");
    const compiledPageValidation = await validateCompiledPdfPageBudget({
      deps: {
        aci: {
          async runCommand(command: string) {
            if (command === "pdftotext -layout main.pdf -") {
              return {
                status: "ok" as const,
                stdout: "",
                stderr: "",
                exit_code: 0,
                duration_ms: 1
              };
            }
            expect(command).toBe("pdfinfo main.pdf");
            return {
              status: "ok" as const,
              stdout: "Title: mock\nPages: 0\n",
              stderr: "",
              exit_code: 0,
              duration_ms: 1
            };
          }
        }
      } as any,
      run,
      compileResult: {
        enabled: true,
        status: "success",
        repaired: false,
        toolCallsUsed: 0,
        attempts: [],
        warnings: [],
        pdf_path: path.join(".autolabos", "runs", run.id, "paper", "main.pdf")
      },
      validationMode: "strict_paper",
      minimumMainPages: 1,
      targetMainPages: 1
    });

    expect(compiledPageValidation.status).toBe("fail");
    expect(compiledPageValidation.outcome).toBe("under_limit");
    expect(compiledPageValidation.compiled_pdf_page_count).toBe(0);
    expect(compiledPageValidation.minimum_main_pages).toBe(1);
    expect(compiledPageValidation.target_main_pages).toBe(1);
    expect(compiledPageValidation.main_page_limit).toBe(1);
  });

  it("passes compiled page-budget validation when the PDF exceeds the target page budget", async () => {
    const run = makeRun("run-paper-pdf-over-target");

    const compiledPageValidation = await validateCompiledPdfPageBudget({
      deps: {
        aci: {
          async runCommand(command: string) {
            if (command === "pdftotext -layout main.pdf -") {
              return {
                status: "ok" as const,
                stdout: Array.from({ length: 10 }, (_, index) => `Main body page ${index + 1}`).join("\f"),
                stderr: "",
                exit_code: 0,
                duration_ms: 1
              };
            }
            expect(command).toBe("pdfinfo main.pdf");
            return {
              status: "ok" as const,
              stdout: "Title: mock\nPages: 10\n",
              stderr: "",
              exit_code: 0,
              duration_ms: 1
            };
          }
        }
      } as any,
      run,
      compileResult: {
        enabled: true,
        status: "success",
        repaired: false,
        toolCallsUsed: 0,
        attempts: [],
        warnings: [],
        pdf_path: path.join(".autolabos", "runs", run.id, "paper", "main.pdf")
      },
      validationMode: "strict_paper",
      minimumMainPages: 8,
      targetMainPages: 8
    });

    expect(compiledPageValidation.status).toBe("pass");
    expect(compiledPageValidation.outcome).toBe("ok");
    expect(compiledPageValidation.compiled_pdf_page_count).toBe(10);
    expect(compiledPageValidation.minimum_main_pages).toBe(8);
    expect(compiledPageValidation.target_main_pages).toBe(8);
    expect(compiledPageValidation.message).toContain("meeting the configured minimum_main_pages");
  });

  it("excludes reference and appendix pages from the main-body page floor", async () => {
    const run = makeRun("run-paper-pdf-main-body-only");
    const compiledPageValidation = await validateCompiledPdfPageBudget({
      deps: {
        aci: {
          async runCommand(command: string) {
            if (command === "pdftotext -layout main.pdf -") {
              return {
                status: "ok" as const,
                stdout: [
                  "Introduction",
                  "Method",
                  "Results",
                  "Discussion",
                  "Limitations",
                  "Conclusion",
                  "References",
                  "Appendix A"
                ].join("\f"),
                stderr: "",
                exit_code: 0,
                duration_ms: 1
              };
            }
            expect(command).toBe("pdfinfo main.pdf");
            return {
              status: "ok" as const,
              stdout: "Title: mock\nPages: 8\n",
              stderr: "",
              exit_code: 0,
              duration_ms: 1
            };
          }
        }
      } as any,
      run,
      compileResult: {
        enabled: true,
        status: "success",
        repaired: false,
        toolCallsUsed: 0,
        attempts: [],
        warnings: [],
        pdf_path: path.join(".autolabos", "runs", run.id, "paper", "main.pdf")
      },
      validationMode: "strict_paper",
      minimumMainPages: 8,
      targetMainPages: 8,
      referencesCounted: false,
      appendicesCounted: false
    });

    expect(compiledPageValidation.status).toBe("fail");
    expect(compiledPageValidation.compiled_pdf_page_count).toBe(8);
    expect(compiledPageValidation.main_body_pdf_page_count).toBe(6);
    expect(compiledPageValidation.references_page_count).toBe(1);
    expect(compiledPageValidation.appendix_page_count).toBe(1);
    expect(compiledPageValidation.message).toContain("Compiled main body is only 6 pages");
  });

  it("fails the node when PDF compilation still fails after repair", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-paper-pdf-fail-"));
    process.chdir(root);

    const run = makeRun("run-paper-pdf-fail");
    const runDir = await seedRun(root, run);
    const aci = createPdfBuildAci({ failAllCompiles: true });
    const eventStream = new InMemoryEventStream();
    const llm = new SequencedLLMClient([
      ...buildSessionResponses(),
      "\\documentclass{article}\n\\begin{document}\nStill broken.\n\\end{document}\n"
    ]);

    const node = createWritePaperNode({
      config: {
        paper: {
          template: "acl",
          build_pdf: true,
          latex_engine: "auto_install"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm,
      codex: {} as any,
      aci: aci.api as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("configured PDF build failed");
    expect(result.error).toContain("Undefined control sequence");
    expect(aci.commands).toEqual([
      "python3 render_paper_figures.py",
      "pdflatex -interaction=nonstopmode -halt-on-error -file-line-error main.tex",
      "pdflatex -interaction=nonstopmode -halt-on-error -file-line-error main.tex"
    ]);

    expect(await exists(path.join(runDir, "paper", "main.tex"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "compile_report.json"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "main.pdf"))).toBe(false);
    expect(await exists(path.join(buildPublicPaperDir(root, run), "main.pdf"))).toBe(false);

    const report = JSON.parse(await readFile(path.join(runDir, "paper", "compile_report.json"), "utf8")) as {
      status: string;
      repaired: boolean;
      attempts: Array<{ repaired: boolean; status: string; error?: string }>;
    };
    expect(report.status).toBe("failed");
    expect(report.repaired).toBe(true);
    expect(report.attempts).toHaveLength(2);
    expect(report.attempts[0]).toMatchObject({ repaired: false, status: "failed" });
    expect(report.attempts[1]).toMatchObject({ repaired: true, status: "failed" });

    const memory = new RunContextMemory(run.memoryRefs.runContextPath);
    expect(await memory.get("write_paper.compile_status")).toBe("failed");
    expect(await memory.get("write_paper.pdf_path")).toBe(null);
    expect(await memory.get("write_paper.last_error")).toMatch(/configured PDF build failed/i);

    expect(eventStream.history().some((event) => event.type === "NODE_COMPLETED")).toBe(false);
    expect(eventStream.history().some((event) => event.type === "TEST_FAILED")).toBe(true);
  });

  it("surfaces weak scientific results as a warning in default mode and rewrites strong claims", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-paper-weak-default-"));
    process.chdir(root);

    const run = makeRun("run-paper-weak-default");
    const runDir = await seedRun(root, run);
    await overwriteRunArtifacts(run, {
      "experiment_plan.yaml": [
        "selected_design:",
        '  title: "Small configured evaluation"',
        "  datasets:",
        '    - "evaluation_suite"'
      ].join("\n"),
      "result_analysis.json": JSON.stringify(
        {
          analysis_version: 1,
          ...buildResultsContractFixture({ subjectValue: 0.72, referenceValue: 0.71 }),
          objective_metric: {
            evaluation: {
              summary: "Observed a small positive difference in one configured evaluation."
            }
          },
          metric_table: [{ key: PRIMARY_METRIC_ID, value: 0.01 }],
          statistical_summary: {
            notes: ["Only a single weak artifact is available."]
          }
        },
        null,
        2
      ) + "\n"
    });
    await writeLatestResults(run, {
      protocol: {
        datasets: ["evaluation_suite"],
        workflows: [SUBJECT_SERIES_ID, REFERENCE_SERIES_ID]
      },
      dataset_summaries: [
        {
          dataset: "evaluation_suite",
          observations: [
            { series_id: SUBJECT_SERIES_ID, metric_id: PRIMARY_METRIC_ID, value: 0.72 },
            { series_id: REFERENCE_SERIES_ID, metric_id: PRIMARY_METRIC_ID, value: 0.71 }
          ]
        }
      ]
    });

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false,
          validation_mode: "default"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildWeakScientificResponses()),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    expect(result.summary).toContain("Scientific gate: warn");
    const gateDecision = JSON.parse(await readFile(path.join(runDir, "paper", "gate_decision.json"), "utf8")) as {
      status: string;
      issues: Array<{ code: string; message: string; outcome?: string }>;
      evidence_summary: { blocked_by_evidence_insufficiency: boolean; thin_sections: string[] };
    };
    expect(gateDecision.status).toBe("warn");
    expect(gateDecision.issues.some((issue) => issue.code.includes("page_budget"))).toBe(true);
    expect(gateDecision.evidence_summary.blocked_by_evidence_insufficiency).toBe(true);
    expect(gateDecision.evidence_summary.thin_sections.length).toBeGreaterThan(0);
    const scientificValidation = JSON.parse(
      await readFile(path.join(runDir, "paper", "scientific_validation.json"), "utf8")
    ) as {
      auto_repairs: { claim_rewrite_count: number };
      evidence_diagnostics: { blocked_by_evidence_insufficiency: boolean; missing_evidence_categories: string[] };
    };
    expect(scientificValidation.auto_repairs.claim_rewrite_count).toBeGreaterThanOrEqual(0);
    expect(scientificValidation.evidence_diagnostics.blocked_by_evidence_insufficiency).toBe(true);
    expect(scientificValidation.evidence_diagnostics.missing_evidence_categories.length).toBeGreaterThan(0);
    const manuscript = JSON.parse(await readFile(path.join(runDir, "paper", "manuscript.json"), "utf8")) as {
      abstract: string;
      sections: Array<{ heading: string; paragraphs: string[] }>;
    };
    expect(manuscript.abstract).not.toMatch(/significant improvement/i);
    expect(manuscript.sections.find((section) => section.heading === "Results")?.paragraphs.join(" ")).not.toMatch(/significant improvement/i);
  });

  it("fails weak scientific results in strict-paper mode while preserving artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-paper-weak-strict-"));
    process.chdir(root);

    const run = makeRun("run-paper-weak-strict");
    const runDir = await seedRun(root, run);
    await overwriteRunArtifacts(run, {
      "experiment_plan.yaml": [
        "selected_design:",
        '  title: "Small configured evaluation"',
        "  datasets:",
        '    - "evaluation_suite"'
      ].join("\n")
    });
    await writeLatestResults(run, {
      protocol: {
        datasets: ["evaluation_suite"],
        workflows: [SUBJECT_SERIES_ID, REFERENCE_SERIES_ID]
      },
      dataset_summaries: []
    });

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false,
          validation_mode: "strict_paper"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildWeakScientificResponses()),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("scientific quality gate failed");
    const gateDecision = JSON.parse(await readFile(path.join(runDir, "paper", "gate_decision.json"), "utf8")) as {
      mode: string;
      status: string;
      failure_reasons: string[];
      evidence_summary: { blocked_by_evidence_insufficiency: boolean };
    };
    expect(gateDecision.mode).toBe("strict_paper");
    expect(gateDecision.status).toBe("fail");
    expect(gateDecision.failure_reasons.length).toBeGreaterThan(0);
    expect(gateDecision.evidence_summary.blocked_by_evidence_insufficiency).toBe(true);
    expect(await exists(path.join(runDir, "paper", "manuscript.json"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "provenance_map.json"))).toBe(true);
    const readinessRisks = JSON.parse(
      await readFile(path.join(runDir, "paper", "readiness_risks.json"), "utf8")
    ) as {
      readiness_state: string;
      risks: Array<{ category: string; status: string; severity: string }>;
    };
    expect(readinessRisks.readiness_state).toBe("blocked_for_paper_scale");
    expect(readinessRisks.risks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "scientific_validation",
          status: "blocked",
          severity: "blocked"
        })
      ])
    );
  });

  it("routes medium-quality runs through the default gate without requiring appendix sections when no appendix policy is provided", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-paper-medium-quality-"));
    process.chdir(root);

    const run = makeRun("run-paper-medium-quality");
    const runDir = await seedRun(root, run);
    await seedMediumScientificRun(run);

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false,
          validation_mode: "default"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildMediumScientificResponses()),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    const gateDecision = JSON.parse(await readFile(path.join(runDir, "paper", "gate_decision.json"), "utf8")) as {
      status: string;
      classification_summary: { auto_repair_count: number };
    };
    expect(gateDecision.status).not.toBe("fail");
    expect(gateDecision.classification_summary.auto_repair_count).toBe(0);
    const manuscript = JSON.parse(await readFile(path.join(runDir, "paper", "manuscript.json"), "utf8")) as {
      sections: Array<{ heading: string; paragraphs: string[] }>;
      appendix_sections?: Array<{ heading: string; paragraphs: string[] }>;
      appendix_tables?: Array<{ caption: string; rows: Array<{ label: string; value: number }> }>;
    };
    expect(manuscript.sections.find((section) => section.heading === "Method")?.paragraphs.length).toBeGreaterThanOrEqual(3);
    expect(manuscript.sections.find((section) => section.heading === "Results")?.paragraphs.length).toBeGreaterThanOrEqual(3);
    expect(manuscript.appendix_sections?.length).toBeGreaterThan(0);
    expect(manuscript.appendix_sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          heading: expect.stringMatching(/^Supplementary /),
          paragraphs: expect.arrayContaining([expect.stringMatching(/run|repeat|protocol|resource/i)])
        })
      ])
    );
    const manuscriptText = [...manuscript.sections, ...(manuscript.appendix_sections || [])]
      .flatMap((section) => section.paragraphs)
      .join(" ");
    expect(manuscriptText).toContain("Evaluated workflow (primary role)");
    expect(manuscriptText).toContain("Reference workflow (baseline role)");
    expect(manuscriptText).not.toMatch(/results_artifact\.(?:comparison|observation)|observation-subject|series-subject/iu);
    const traceability = JSON.parse(await readFile(path.join(runDir, "paper", "traceability.json"), "utf8")) as {
      paragraphs: Array<{ source_refs?: Array<{ kind: string; id: string }> }>;
    };
    expect(traceability.paragraphs.some((paragraph) => (paragraph.source_refs || []).length > 0)).toBe(true);
    const provenanceMap = JSON.parse(await readFile(path.join(runDir, "paper", "provenance_map.json"), "utf8")) as {
      paragraph_anchors: Array<{ anchor_id: string; numeric_fact_ids: string[] }>;
      numeric_anchors: Array<{ support_status: string }>;
    };
    expect(provenanceMap.paragraph_anchors.length).toBeGreaterThan(0);
    expect(provenanceMap.numeric_anchors.some((anchor) => anchor.support_status === "supported")).toBe(true);
  });

  it("hard-fails inconsistent manuscripts when abstract/results/conclusion numbers diverge", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-paper-inconsistent-"));
    process.chdir(root);

    const run = makeRun("run-paper-inconsistent");
    const runDir = await seedRun(root, run);
    await seedMediumScientificRun(run);

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false,
          validation_mode: "default"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildInconsistentScientificResponses()),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("scientific quality gate failed");
    const gateDecision = JSON.parse(await readFile(path.join(runDir, "paper", "gate_decision.json"), "utf8")) as {
      status: string;
      failure_reasons: string[];
      classification_summary: { contradiction_count: number };
    };
    expect(gateDecision.status).toBe("fail");
    expect(gateDecision.failure_reasons.some((message) => /conflict|contradict|inconsisten/i.test(message))).toBe(true);
    expect(gateDecision.classification_summary.contradiction_count).toBeGreaterThan(0);
    const consistency = JSON.parse(await readFile(path.join(runDir, "paper", "consistency_lint.json"), "utf8")) as {
      manuscript: { issues: Array<{ kind: string; involved_sections?: string[] }> };
    };
    expect(consistency.manuscript.issues.some((issue) => issue.kind === "numeric_inconsistency")).toBe(true);
    expect(consistency.manuscript.issues.some((issue) => issue.kind === "count_inconsistency")).toBe(true);
    expect(
      consistency.manuscript.issues.some(
        (issue) => issue.kind === "numeric_inconsistency" && (issue.involved_sections || []).length > 0
      )
    ).toBe(true);
  });

  it("fails fast before drafting when the brief evidence gate blocks paper progression", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-paper-eligibility-"));
    process.chdir(root);

    const run = makeRun("run-paper-eligibility");
    const runDir = await seedRun(root, run);
    const memory = new RunContextMemory(run.memoryRefs.runContextPath);
    await memory.put("analyze_results.brief_evidence_assessment", {
      generated_at: new Date().toISOString(),
      enabled: true,
      status: "fail",
      summary: "Brief evidence gate failed — repeated runs and comparator coverage are still below the declared minimum.",
      ceiling_type: "research_memo",
      recommended_action: "backtrack_to_design",
      requirements: {
        minimum_runs_or_folds: 3,
        minimum_baseline_count: 2,
        requires_confidence_intervals: true
      },
      actual: {
        executed_trials: 1,
        baseline_count: 1,
        confidence_interval_count: 0,
        evidence_gap_count: 1,
        scope_limit_count: 0
      },
      checks: [],
      failures: ["Executed evidence meets the brief run/fold floor"],
      warnings: []
    });
    await memory.put("review.paper_critique", {
      stage: "pre_draft_review",
      manuscript_type: "research_memo",
      overall_decision: "backtrack_to_design",
      confidence: 0.9
    });
    await mkdir(path.join(runDir, "review"), { recursive: true });
    await writeFile(
      path.join(runDir, "review", "paper_critique.json"),
      JSON.stringify(
        {
          stage: "pre_draft_review",
          generated_at: new Date().toISOString(),
          manuscript_type: "research_memo",
          overall_decision: "backtrack_to_design",
          overall_score: 2.4,
          confidence: 0.9,
          blocking_issues_count: 2,
          non_blocking_issues_count: 0,
          category_scores: [],
          blocking_issues: [],
          non_blocking_issues: [],
          transition_recommendation: "backtrack_to_design",
          paper_readiness_state: "research_memo",
          downgrade_reason: "Evidence remained below the brief floor.",
          manuscript_claim_risk_summary: "Evidence is still too thin for paper-scale drafting.",
          needs_additional_experiments: true,
          needs_additional_statistics: true,
          needs_additional_related_work: false,
          needs_design_revision: true
        },
        null,
        2
      ),
      "utf8"
    );

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false,
          validation_mode: "default"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildSessionResponses()),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("write_paper blocked by brief evidence gate");
    const eligibility = JSON.parse(await readFile(path.join(runDir, "paper", "write_paper_eligibility.json"), "utf8")) as {
      allowed: boolean;
      brief_evidence_status?: string;
      manuscript_type?: string;
    };
    expect(eligibility.allowed).toBe(false);
    expect(eligibility.brief_evidence_status).toBe("fail");
    expect(eligibility.manuscript_type).toBe("research_memo");
    const runReadiness = JSON.parse(await readFile(path.join(runDir, "paper", "paper_readiness.json"), "utf8")) as {
      paper_ready: boolean;
      readiness_state: string;
      triggered_by: string[];
    };
    expect(runReadiness.paper_ready).toBe(false);
    expect(runReadiness.readiness_state).toBe("research_memo");
    expect(runReadiness.triggered_by).toContain("write_paper_eligibility");
    const publicReadiness = JSON.parse(
      await readFile(path.join(buildPublicPaperDir(root, run), "paper_readiness.json"), "utf8")
    ) as { paper_ready: boolean; readiness_state: string };
    expect(publicReadiness.paper_ready).toBe(false);
    expect(publicReadiness.readiness_state).toBe("research_memo");
  });

  it("runs manuscript review after polish and records manuscript-quality artifacts for a clean manuscript", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-manuscript-quality-clean-"));
    process.chdir(root);

    const run = makeRun("run-manuscript-quality-clean");
    const runDir = await seedRun(root, run);
    await mkdir(path.join(runDir, "paper"), { recursive: true });
    await writeFile(
      path.join(runDir, "paper", "manuscript_quality_failure.json"),
      JSON.stringify({ stale: true }),
      "utf8"
    );

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient([
        ...buildSessionResponses(),
        buildPolishedManuscriptResponse(),
        buildManuscriptReviewResponse({ decision: "pass" }),
        buildManuscriptReviewAuditResponse()
      ]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    expect(await exists(path.join(runDir, "paper", "manuscript_review.json"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "manuscript_review_validation.json"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "manuscript_review_audit.json"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "manuscript_style_lint.json"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "manuscript_quality_gate.json"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "claim_evidence_table.json"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "verified_registry.json"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "claim_status_table.json"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "evidence_gate_decision.json"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "paper_readiness.json"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "readiness_risks.json"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "manuscript_repair_1_report.json"))).toBe(false);
    expect(await exists(path.join(runDir, "paper", "manuscript_quality_failure.json"))).toBe(false);
    const gate = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_quality_gate.json"), "utf8")
    ) as { action: string; summary_lines: string[] };
    expect(gate.action).toBe("pass");
    expect(gate.summary_lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Action:\s+pass/i),
        expect.stringMatching(/Decision stage:\s+initial manuscript-quality gate/i),
        expect.stringMatching(/Review reliability:/i)
      ])
    );

    const traceRaw = await readFile(path.join(runDir, "paper", "session_trace.json"), "utf8");
    expect(traceRaw.indexOf('"stage": "polish"')).toBeGreaterThanOrEqual(0);
    expect(traceRaw.indexOf('"stage": "manuscript_review"')).toBeGreaterThan(traceRaw.indexOf('"stage": "polish"'));
    expect(traceRaw.indexOf('"stage": "manuscript_review_audit"')).toBeGreaterThan(
      traceRaw.indexOf('"stage": "manuscript_review"')
    );

    const claimStatus = JSON.parse(
      await readFile(path.join(runDir, "paper", "claim_status_table.json"), "utf8")
    ) as { counts: { verified: number } };
    expect(claimStatus.counts.verified).toBeGreaterThan(0);

    const verifiedRegistry = JSON.parse(
      await readFile(path.join(runDir, "paper", "verified_registry.json"), "utf8")
    ) as { counts: { verified: number; inferred: number; blocked: number } };
    expect(verifiedRegistry.counts.verified + verifiedRegistry.counts.inferred).toBeGreaterThan(0);
    expect(verifiedRegistry.counts.blocked).toBe(0);

    const paperReadiness = JSON.parse(
      await readFile(path.join(runDir, "paper", "paper_readiness.json"), "utf8")
    ) as { paper_ready: boolean; evidence_gate_status: string; citation_check: string };
    expect(typeof paperReadiness.paper_ready).toBe("boolean");
    expect(paperReadiness.evidence_gate_status).toBe("pass");
    expect(paperReadiness.citation_check).toBe("pass");
    const readinessRisks = JSON.parse(
      await readFile(path.join(runDir, "paper", "readiness_risks.json"), "utf8")
    ) as { risk_count: number; summary_lines: string[] };
    expect(readinessRisks.risk_count).toBeGreaterThanOrEqual(0);
    expect(readinessRisks.summary_lines.length).toBeGreaterThan(0);
  });

  it("grounds unlinked result claims in the canonical V2 analysis artifact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-artifact-claims-"));
    process.chdir(root);

    const run = makeRun("run-artifact-claim-grounding");
    const runDir = await seedRun(root, run);
    const runArtifactContract = buildResultsContractFixture({ subjectValue: 0.56, referenceValue: 0.51 });
    const primaryComparison = runArtifactContract.results_artifact.comparisons.find(
      (comparison) => comparison.id === runArtifactContract.primary_comparison_id
    )!;
    const primaryMetric = runArtifactContract.results_artifact.metrics.find(
      (metric) => metric.id === PRIMARY_METRIC_ID
    )!;
    const metricClaim = `The declared primary comparison reports a ${primaryMetric.label} difference of ${primaryComparison.delta.toFixed(2)} ${primaryMetric.unit}.`;
    await writeFile(
      path.join(runDir, "result_analysis.json"),
      JSON.stringify(
        {
          analysis_version: 1,
          overview: { objective_status: "observed" },
          execution_summary: { observation_count: runArtifactContract.results_artifact.observations.length },
          ...runArtifactContract
        },
        null,
        2
      ),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "result_table.json"),
      JSON.stringify(runArtifactContract, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "metrics.json"),
      JSON.stringify(
        {
          status: "completed",
          subject_minus_reference_difference: 0.05,
          reference_outcome_score: 0.51,
          subject_outcome_score: 0.56
        },
        null,
        2
      ),
      "utf8"
    );

    const outline = JSON.stringify({
      title: "Run Artifact Claim Grounding",
      abstract_focus: ["baseline comparison", "run artifacts"],
      section_headings: ["Introduction", "Method", "Results", "Discussion", "Limitations", "Conclusion"],
      key_claim_themes: [metricClaim],
      citation_plan: []
    });
    const draft = JSON.stringify({
      title: "Run Artifact Claim Grounding",
      abstract: "A conservative report over a completed baseline comparison.",
      keywords: ["run artifacts", "claim evidence"],
      sections: [
        {
          heading: "Introduction",
          paragraphs: ["This report studies whether paper claims remain grounded in generated run artifacts."],
          evidence_ids: [],
          citation_paper_ids: []
        },
        {
          heading: "Method",
          paragraphs: ["The protocol compares Evaluated workflow (primary role) with Reference workflow (baseline role) under the held-out partition."],
          evidence_ids: [],
          citation_paper_ids: []
        },
        {
          heading: "Results",
          paragraphs: [metricClaim],
          evidence_ids: [],
          citation_paper_ids: []
        },
        {
          heading: "Discussion",
          paragraphs: ["The result supports only a narrow interpretation within the completed run."],
          evidence_ids: [],
          citation_paper_ids: []
        },
        {
          heading: "Limitations",
          paragraphs: ["The evidence remains limited to one compact benchmark setting."],
          evidence_ids: [],
          citation_paper_ids: []
        },
        {
          heading: "Conclusion",
          paragraphs: ["The generated report should keep quantitative claims linked to run artifacts."],
          evidence_ids: [],
          citation_paper_ids: []
        }
      ],
      claims: [
        {
          claim_id: "c_run_result",
          statement: metricClaim,
          section_heading: "Results",
          evidence_ids: [],
          citation_paper_ids: []
        },
        {
          claim_id: "c_literature_context",
          statement: "Prior benchmark design work motivates careful evidence linkage.",
          section_heading: "Introduction",
          evidence_ids: ["ev_1"],
          citation_paper_ids: ["paper_1"]
        },
        {
          claim_id: "c_run_conclusion",
          statement: "The preflight appears strong enough to justify cautious continuation but not broad generalization.",
          section_heading: "Conclusion",
          evidence_ids: [],
          citation_paper_ids: []
        }
      ]
    });
    const review = JSON.stringify({
      summary: "The draft is conservative.",
      revision_notes: [],
      unsupported_claims: [],
      missing_sections: [],
      missing_citations: []
    });

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient([
        outline,
        draft,
        review,
        draft,
        buildPolishedManuscriptResponse(),
        buildManuscriptReviewResponse({ decision: "pass" }),
        buildManuscriptReviewAuditResponse()
      ]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    const claimEvidence = JSON.parse(
      await readFile(path.join(runDir, "paper", "claim_evidence_table.json"), "utf8")
    ) as { claims: Array<{ claim_id: string; artifact_refs: string[]; strength: string }> };
    const evidenceLinks = JSON.parse(
      await readFile(path.join(runDir, "paper", "evidence_links.json"), "utf8")
    ) as { claims: Array<{ claim_id: string; evidence_ids: string[] }> };
    const claimStatus = JSON.parse(
      await readFile(path.join(runDir, "paper", "claim_status_table.json"), "utf8")
    ) as {
      claims: Array<{
        claim_id: string;
        status: string;
        primary_source_present: boolean;
        run_artifact_present: boolean;
        artifact_refs: string[];
      }>;
    };

    const evidenceRow = claimEvidence.claims.find((claim) => claim.claim_id === "c_run_result");
    expect(evidenceRow?.artifact_refs).toEqual(["result_analysis.json"]);
    expect(evidenceRow?.strength).not.toBe("low");

    const evidenceLinkRow = evidenceLinks.claims.find((claim) => claim.claim_id === "c_run_result");
    expect(evidenceLinkRow?.evidence_ids).toEqual(["result_analysis.json"]);

    const statusRow = claimStatus.claims.find((claim) => claim.claim_id === "c_run_result");
    expect(statusRow?.status).toBe("verified");
    expect(statusRow?.primary_source_present).toBe(true);
    expect(statusRow?.run_artifact_present).toBe(true);
    expect(statusRow?.artifact_refs).toEqual(["result_analysis.json"]);

    const literatureRow = claimEvidence.claims.find((claim) => claim.claim_id === "c_literature_context");
    expect(literatureRow?.artifact_refs).toEqual(["ev_1"]);

    const conclusionRow = claimStatus.claims.find((claim) => claim.claim_id === "c_run_conclusion");
    expect(conclusionRow?.status).not.toBe("unverified");
    expect(conclusionRow?.artifact_refs).toEqual(expect.arrayContaining(["result_analysis.json"]));
  });

  it("retries manuscript review once when supporting-span validation fails and records validation plus audit artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-manuscript-review-retry-"));
    process.chdir(root);

    const run = makeRun("run-manuscript-review-retry");
    const runDir = await seedRun(root, run);

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildReviewRetryResponses()),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    const validation = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_review_validation.json"), "utf8")
    ) as { ok: boolean; retry_requested: boolean; artifact_reliability: string };
    expect(validation.ok).toBe(true);
    expect(validation.retry_requested).toBe(false);
    expect(validation.artifact_reliability).toBe("grounded");

    const audit = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_review_audit.json"), "utf8")
    ) as { ok: boolean; artifact_reliability: string };
    expect(audit.ok).toBe(true);
    expect(audit.artifact_reliability).toBe("grounded");

    const traceRaw = await readFile(path.join(runDir, "paper", "session_trace.json"), "utf8");
    expect(traceRaw).toContain('"stage": "manuscript_review_retry"');
    expect(traceRaw).toContain('"stage": "manuscript_review_audit"');
  });

  it("runs one manuscript repair pass for repairable manuscript issues and records artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-manuscript-quality-repair1-"));
    process.chdir(root);

    const run = makeRun("run-manuscript-quality-repair1");
    const runDir = await seedRun(root, run);

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildManuscriptRepairOnceResponses()),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    expect(await exists(path.join(runDir, "paper", "manuscript_repair_plan_1.json"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "manuscript_repair_verification_1.json"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "manuscript_repair_1_report.json"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "manuscript_repair_2_report.json"))).toBe(false);

    const repairPlan = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_repair_plan_1.json"), "utf8")
    ) as { targets: Array<{ section: string; paragraph_index?: number; location_key: string }> };
    expect(repairPlan.targets.some((target) => target.section === "Discussion" && target.paragraph_index === 0)).toBe(true);

    const verification = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_repair_verification_1.json"), "utf8")
    ) as { locality_ok: boolean; out_of_scope_changes: string[] };
    expect(verification.locality_ok).toBe(true);
    expect(verification.out_of_scope_changes).toHaveLength(0);

    const repairReport = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_repair_1_report.json"), "utf8")
    ) as {
      pass_index: number;
      improvement_detected: boolean;
      verification_summary: string;
      verification_findings: Array<{ code: string }>;
      stop_or_continue_reason: string;
    };
    expect(repairReport.pass_index).toBe(1);
    expect(repairReport.improvement_detected).toBe(true);
    expect(repairReport.verification_summary).toMatch(/bounded-local changes/i);
    expect(repairReport.verification_findings).toEqual([]);
    expect(repairReport.stop_or_continue_reason).toMatch(/resolved|non-blocking|repair/i);

    const round0Review = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_review_round_0.json"), "utf8")
    ) as {
      issues: Array<{ supporting_spans?: Array<{ section: string; paragraph_index: number; excerpt: string }> }>;
    };
    expect(round0Review.issues[0]?.supporting_spans?.[0]?.section).toBe("Discussion");

    const round0Gate = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_quality_gate_round_0.json"), "utf8")
    ) as { triggered_by: string[]; summary_lines: string[] };
    expect(round0Gate.triggered_by).toContain("paragraph_redundancy");
    expect(round0Gate.triggered_by).not.toContain("duplicate_sentence_pattern");
    expect(round0Gate.summary_lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Action:\s+repair/i),
        expect.stringMatching(/Triggered by:\s+.*paragraph_redundancy/i)
      ])
    );

    const round0Lint = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_style_lint_round_0.json"), "utf8")
    ) as {
      summary: string[];
      issues: Array<{ code: string; coverage_status?: string; covered_by_review_issue_code?: string }>;
    };
    expect(round0Lint.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate_sentence_pattern",
          coverage_status: "backstop_only",
          covered_by_review_issue_code: "paragraph_redundancy"
        })
      ])
    );
    expect(round0Lint.summary.some((line) => /backstop-only/i.test(line))).toBe(true);
  });

  it("allows a bounded local adjacent-two-paragraph repair for section transitions in one section", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-manuscript-transition-repair-"));
    process.chdir(root);

    const run = makeRun("run-manuscript-transition-repair");
    const runDir = await seedRun(root, run);

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildSectionTransitionAdjacentRepairResponses()),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    const repairPlan = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_repair_plan_1.json"), "utf8")
    ) as { targets: Array<{ section: string; edit_scope: string; allowed_location_keys: string[] }> };
    expect(
      repairPlan.targets.some(
        (target) =>
          target.section === "Results"
          && target.edit_scope === "adjacent_two_paragraphs"
          && target.allowed_location_keys.includes("paragraph:results:0")
          && target.allowed_location_keys.includes("paragraph:results:1")
      )
    ).toBe(true);

    const verification = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_repair_verification_1.json"), "utf8")
    ) as { locality_ok: boolean; scope_respected: boolean; changed_location_keys: string[] };
    expect(verification.locality_ok).toBe(true);
    expect(verification.scope_respected).toBe(true);
    expect(verification.changed_location_keys).toEqual(
      expect.arrayContaining(["paragraph:results:0", "paragraph:results:1"])
    );
  });

  it("does not count deterministic final cleanup as an out-of-scope repair change", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-manuscript-cleanup-locality-"));
    process.chdir(root);

    const run = makeRun("run-manuscript-cleanup-locality");
    const runDir = await seedRun(root, run);

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildSectionTransitionRepairWithGlobalCleanupNoiseResponses()),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    const verification = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_repair_verification_1.json"), "utf8")
    ) as { locality_ok: boolean; out_of_scope_changes: string[]; changed_location_keys: string[] };
    expect(verification.locality_ok).toBe(true);
    expect(verification.out_of_scope_changes).toHaveLength(0);
    expect(verification.changed_location_keys).not.toContain("paragraph:method:2");
    expect(verification.changed_location_keys).toEqual(
      expect.arrayContaining(["paragraph:results:0", "paragraph:results:1"])
    );
  });

  it("allows a bounded local adjacent-two-paragraph repair for introduction alignment", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-manuscript-alignment-repair-"));
    process.chdir(root);

    const run = makeRun("run-manuscript-alignment-repair");
    const runDir = await seedRun(root, run);

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildIntroductionAlignmentAdjacentRepairResponses()),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    const repairPlan = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_repair_plan_1.json"), "utf8")
    ) as { targets: Array<{ section: string; edit_scope: string; allowed_location_keys: string[] }> };
    expect(
      repairPlan.targets.some(
        (target) =>
          target.section === "Introduction"
          && target.edit_scope === "adjacent_two_paragraphs"
          && target.allowed_location_keys.includes("paragraph:introduction:0")
          && target.allowed_location_keys.includes("paragraph:introduction:1")
      )
    ).toBe(true);

    const verification = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_repair_verification_1.json"), "utf8")
    ) as { locality_ok: boolean; scope_respected: boolean; changed_location_keys: string[] };
    expect(verification.locality_ok).toBe(true);
    expect(verification.scope_respected).toBe(true);
    expect(verification.changed_location_keys).toEqual(
      expect.arrayContaining(["paragraph:introduction:0", "paragraph:introduction:1"])
    );
  });

  it("narrows visual redundancy repair targets to the canonical V2 table/figure pair", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-manuscript-visual-pair-repair-"));
    process.chdir(root);

    const run = makeRun("run-manuscript-visual-pair-repair");
    const runDir = await seedRun(root, run);

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildVisualRedundancyPairRepairResponses()),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    const sessionManuscript = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript.session.json"), "utf8")
    ) as {
      tables?: Array<{ rows: Array<{ label: string; comparison_side?: string; series_role?: string }> }>;
      figures?: Array<{ bars: Array<{ label: string; comparison_side?: string; series_role?: string }> }>;
    };
    expect(sessionManuscript.tables?.[0]?.rows).toHaveLength(3);
    expect(sessionManuscript.figures).toHaveLength(1);
    expect(sessionManuscript.figures?.[0]?.bars).toMatchObject([
      { comparison_side: "subject", series_role: "primary" },
      { comparison_side: "reference", series_role: "baseline" }
    ]);

    const styleLint = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_style_lint_round_0.json"), "utf8")
    ) as {
      summary: string[];
      issues: Array<{
        code: string;
        coverage_status?: string;
        covered_by_review_issue_code?: string;
        redundant_visual_pair?: { table_index: number; figure_index: number };
      }>;
    };
    expect(styleLint.issues.some((issue) => issue.code === "visual_redundancy")).toBe(false);
    expect(styleLint.summary.join(" ")).not.toMatch(/visual-redundancy finding\(s\).*backstop-only/i);

    const round0Review = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_review_round_0.json"), "utf8")
    ) as {
      issues: Array<{
        code: string;
        visual_targets?: Array<{ kind: string; index: number }>;
      }>;
    };
    expect(round0Review.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "visual_redundancy",
          visual_targets: expect.arrayContaining([
            expect.objectContaining({ kind: "table", index: 0 }),
            expect.objectContaining({ kind: "figure", index: 0 })
          ])
        })
      ])
    );

    const repairPlan = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_repair_plan_1.json"), "utf8")
    ) as { targets: Array<{ kind: string; location_key: string; allowed_location_keys: string[] }> };
    expect(repairPlan.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "table", location_key: "table:0", allowed_location_keys: ["table:0"] }),
        expect.objectContaining({ kind: "figure", location_key: "figure:0", allowed_location_keys: ["figure:0"] })
      ])
    );
    expect(repairPlan.targets.some((target) => target.location_key === "figure:1")).toBe(false);

    const verification = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_repair_verification_1.json"), "utf8")
    ) as {
      locality_ok: boolean;
      changed_location_keys: string[];
      out_of_scope_changes: string[];
      visual_caption_conservatism_ok: boolean;
      visual_caption_checks: Array<{ location_key: string; conservative: boolean; concerns: string[] }>;
    };
    expect(verification.locality_ok).toBe(true);
    expect(verification.changed_location_keys).toEqual([]);
    expect(verification.out_of_scope_changes).toHaveLength(0);
    expect(verification.visual_caption_conservatism_ok).toBe(true);
    expect(verification.visual_caption_checks).toEqual([]);

    const finalManuscript = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript.json"), "utf8")
    ) as {
      figures?: Array<{
        caption: string;
        bars: Array<{ label: string; comparison_side?: string; series_role?: string }>;
      }>;
    };
    expect(finalManuscript.figures).toHaveLength(1);
    expect(finalManuscript.figures?.[0]?.caption).toContain(`primary comparison for ${PRIMARY_METRIC_LABEL}`);
    expect(finalManuscript.figures?.[0]?.bars).toMatchObject([
      { comparison_side: "subject", series_role: "primary" },
      { comparison_side: "reference", series_role: "baseline" }
    ]);
    expect(JSON.stringify(finalManuscript.figures)).not.toMatch(/trend-focused|remain unchanged/iu);
  });

  it("restores the canonical V2 figure when a repair proposes an overclaiming caption", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-manuscript-visual-caption-canonical-"));
    process.chdir(root);

    const run = makeRun("run-manuscript-visual-caption-canonical");
    const runDir = await seedRun(root, run);

    const node = createWritePaperNode({
      config: { paper: { build_pdf: false } } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildVisualCaptionOverclaimRepairResponses()),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    expect(await exists(path.join(runDir, "paper", "manuscript_repair_2_report.json"))).toBe(false);

    const verification = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_repair_verification_1.json"), "utf8")
    ) as {
      changed_location_keys: string[];
      visual_caption_conservatism_ok: boolean;
      visual_caption_checks: Array<{ location_key: string; conservative: boolean; concerns: string[] }>;
    };
    expect(verification.changed_location_keys).toEqual([]);
    expect(verification.visual_caption_conservatism_ok).toBe(true);
    expect(verification.visual_caption_checks).toEqual([]);

    const manuscript = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript.json"), "utf8")
    ) as { figures?: Array<{ caption: string }> };
    expect(manuscript.figures).toHaveLength(1);
    expect(manuscript.figures?.[0]?.caption).toContain(`primary comparison for ${PRIMARY_METRIC_LABEL}`);
    expect(JSON.stringify(manuscript.figures)).not.toMatch(/broad applicability/iu);

    const repairReport = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_repair_1_report.json"), "utf8")
    ) as { verification_findings: Array<{ code: string }> };
    expect(repairReport.verification_findings.some((finding) => finding.code === "visual_caption_overclaim")).toBe(false);
  });

  it("stops immediately when appendix contamination is missed by the reviewer and remains a hard-stop policy finding", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-manuscript-appendix-hard-stop-"));
    process.chdir(root);

    const run = makeRun("run-manuscript-appendix-hard-stop");
    const runDir = await seedRun(root, run);

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildAppendixHardStopResponses()),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(await exists(path.join(runDir, "paper", "manuscript_repair_1_report.json"))).toBe(false);

    const gate = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_quality_gate.json"), "utf8")
    ) as {
      action: string;
      decision_digest: { stop_reason_category: string };
      summary_lines: string[];
    };
    expect(gate.action).toBe("stop");
    expect(gate.decision_digest.stop_reason_category).toBe("policy_hard_stop");
    expect(gate.summary_lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Reason category:\s+policy_hard_stop/i)
      ])
    );

    const round0Lint = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_style_lint_round_0.json"), "utf8")
    ) as {
      issues: Array<{ code: string; gate_role?: string; coverage_status?: string }>;
    };
    expect(round0Lint.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "appendix_meta_text",
          gate_role: "hard_stop",
          coverage_status: "primary"
        })
      ])
    );

    const failureArtifact = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_quality_failure.json"), "utf8")
    ) as {
      decision_digest: { stop_reason_category: string };
      reviewer_missed_policy_findings: Array<{ code: string; gate_role?: string }>;
    };
    expect(failureArtifact.decision_digest.stop_reason_category).toBe("policy_hard_stop");
    expect(failureArtifact.reviewer_missed_policy_findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "appendix_meta_text",
          gate_role: "hard_stop"
        })
      ])
    );
  });

  it("treats appendix contamination as backstop-only when manuscript review already covers the same appendix-local issue", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-manuscript-appendix-backstop-"));
    process.chdir(root);

    const run = makeRun("run-manuscript-appendix-backstop");
    const runDir = await seedRun(root, run);

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildAppendixBackstopRepairResponses()),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    const round0Lint = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_style_lint_round_0.json"), "utf8")
    ) as {
      issues: Array<{ code: string; gate_role?: string; coverage_status?: string; covered_by_review_issue_code?: string }>;
    };
    expect(round0Lint.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "appendix_meta_text",
          gate_role: "backstop_only",
          coverage_status: "backstop_only",
          covered_by_review_issue_code: "appendix_hygiene"
        })
      ])
    );

    const repairPlan = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_repair_plan_1.json"), "utf8")
    ) as { targets: Array<{ kind: string; location_key: string }> };
    expect(repairPlan.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "appendix_paragraph",
          location_key: "appendix_paragraph:appendix._notes:0"
        })
      ])
    );
  });

  it("restores the canonical V2 table when a repair proposes an overclaiming caption", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-manuscript-table-caption-canonical-"));
    process.chdir(root);

    const run = makeRun("run-manuscript-table-caption-canonical");
    const runDir = await seedRun(root, run);

    const node = createWritePaperNode({
      config: { paper: { build_pdf: false } } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildTableCaptionOverclaimRepairResponses()),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    const verification = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_repair_verification_1.json"), "utf8")
    ) as {
      visual_caption_conservatism_ok: boolean;
      visual_caption_checks: Array<{ location_key: string; conservative: boolean; concerns: string[] }>;
      visual_conservatism_ok: boolean;
    };
    expect(verification.visual_caption_conservatism_ok).toBe(true);
    expect(verification.visual_conservatism_ok).toBe(true);
    expect(verification.visual_caption_checks).toEqual([]);

    const manuscript = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript.json"), "utf8")
    ) as { tables?: Array<{ caption: string }> };
    expect(manuscript.tables).toHaveLength(1);
    expect(manuscript.tables?.[0]?.caption).toContain(`Declared primary comparison for ${PRIMARY_METRIC_LABEL}`);
    expect(JSON.stringify(manuscript.tables)).not.toMatch(/broad applicability/iu);
  });

  it("restores canonical V2 labels when a repair proposes an overclaiming visual label", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-manuscript-visual-label-canonical-"));
    process.chdir(root);

    const run = makeRun("run-manuscript-visual-label-canonical");
    const runDir = await seedRun(root, run);

    const node = createWritePaperNode({
      config: { paper: { build_pdf: false } } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildVisualLabelOverclaimRepairResponses()),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    const verification = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_repair_verification_1.json"), "utf8")
    ) as {
      visual_label_conservatism_ok: boolean;
      visual_label_checks: Array<{ location_key: string; conservative: boolean; concerns: string[]; labels: string[] }>;
      visual_conservatism_ok: boolean;
    };
    expect(verification.visual_label_conservatism_ok).toBe(true);
    expect(verification.visual_conservatism_ok).toBe(true);
    expect(verification.visual_label_checks).toEqual([]);

    const manuscript = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript.json"), "utf8")
    ) as { figures?: Array<{ bars: Array<{ label: string; series_role?: string }> }> };
    expect(manuscript.figures?.[0]?.bars).toMatchObject([
      { label: "Evaluated workflow (primary role, subject)", series_role: "primary" },
      { label: "Reference workflow (baseline role, reference)", series_role: "baseline" }
    ]);
    expect(JSON.stringify(manuscript.figures)).not.toMatch(/broad applicability/iu);

    const repairReport = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_repair_1_report.json"), "utf8")
    ) as { verification_findings: Array<{ code: string }> };
    expect(repairReport.verification_findings.some((finding) => finding.code === "visual_label_overclaim")).toBe(false);
  });

  it("does not allow a second repair when the follow-up review is only partially grounded", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-manuscript-partially-grounded-stop-"));
    process.chdir(root);

    const run = makeRun("run-manuscript-partially-grounded-stop");
    const runDir = await seedRun(root, run);

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildPartiallyGroundedRepairStopResponses()),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(await exists(path.join(runDir, "paper", "manuscript_repair_2_report.json"))).toBe(false);

    const reviewAudit = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_review_audit.json"), "utf8")
    ) as { artifact_reliability: string; metrics: { retry_used: boolean } };
    expect(reviewAudit.artifact_reliability).toBe("partially_grounded");
    expect(reviewAudit.metrics.retry_used).toBe(false);

    const gate = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_quality_gate.json"), "utf8")
    ) as {
      action: string;
      stop_or_continue_reason: string;
      decision_digest: { stop_reason_category: string; review_reliability: string };
    };
    expect(gate.action).toBe("stop");
    expect(gate.stop_or_continue_reason).toMatch(/partially grounded|second manuscript repair is not allowed/i);
    expect(gate.decision_digest.stop_reason_category).toBe("review_reliability");
    expect(gate.decision_digest.review_reliability).toBe("partially_grounded");
  });

  it("allows a second repair when a partially grounded follow-up audit has only warning-level grounding gaps", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-manuscript-partially-grounded-repair2-"));
    process.chdir(root);

    const run = makeRun("run-manuscript-partially-grounded-repair2");
    const runDir = await seedRun(root, run);

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildPartiallyGroundedRepairStopResponses({
        auditIssueSeverity: "warning",
        followupIssueSeverity: "fail"
      })),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    expect(await exists(path.join(runDir, "paper", "manuscript_repair_2_report.json"))).toBe(true);

    const round1Gate = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_quality_gate_round_1.json"), "utf8")
    ) as { action: string; stop_or_continue_reason: string; allowed_max_passes: number };
    expect(round1Gate.action, round1Gate.stop_or_continue_reason).toBe("repair");
    expect(round1Gate.allowed_max_passes).toBe(2);
    expect(round1Gate.stop_or_continue_reason).toMatch(/partially grounded|second and final manuscript repair/i);
  });

  it("uses the second repair pass for warning-only partially grounded follow-up review issues", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-manuscript-partially-grounded-warning-pass-"));
    process.chdir(root);

    const run = makeRun("run-manuscript-partially-grounded-warning-pass");
    const runDir = await seedRun(root, run);

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildPartiallyGroundedRepairStopResponses({
        auditIssueCode: "unsupported_issue",
        auditIssueSeverity: "warning"
      })),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    expect(await exists(path.join(runDir, "paper", "manuscript_repair_2_report.json"))).toBe(true);

    const gate = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_quality_gate.json"), "utf8")
    ) as {
      action: string;
      stop_or_continue_reason: string;
      decision_digest: { stop_reason_category: string; review_reliability: string };
    };
    expect(gate.action).toBe("pass");
    expect(gate.stop_or_continue_reason).toMatch(/resolved|passed|non-blocking manuscript warnings/i);
    expect(gate.decision_digest.stop_reason_category).toBe("clean_pass");
    expect(gate.decision_digest.review_reliability).toBe("grounded");
  });

  it("drops out-of-scope repair edits before manuscript-quality verification", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-manuscript-quality-locality-stop-"));
    process.chdir(root);

    const run = makeRun("run-manuscript-quality-locality-stop");
    const runDir = await seedRun(root, run);

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildOutOfScopeRepairResponses()),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    const verification = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_repair_verification_1.json"), "utf8")
    ) as { locality_ok: boolean; unexpected_changed_sections: string[]; out_of_scope_changes: string[] };
    expect(verification.locality_ok).toBe(true);
    expect(verification.unexpected_changed_sections).not.toContain("introduction");
    expect(verification.unexpected_changed_sections).not.toContain("method");
    expect(verification.out_of_scope_changes).not.toContain("paragraph:method:2");

    const repaired = JSON.parse(await readFile(path.join(runDir, "paper", "manuscript_repair_1.json"), "utf8")) as {
      sections: Array<{ heading: string; paragraphs: string[] }>;
    };
    expect(repaired.sections[0].paragraphs[0]).not.toMatch(/unrelated introduction rewrite/i);
    expect(repaired.sections[2].paragraphs[2]).not.toMatch(/unrelated method rewrite/i);
    expect(repaired.sections[4].paragraphs[0]).toMatch(/interprets the result/i);

    const gate = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_quality_gate.json"), "utf8")
    ) as { action: string; stop_or_continue_reason: string };
    expect(gate.action).toBe("pass");
    expect(gate.stop_or_continue_reason).toMatch(/resolved|passed|non-blocking manuscript warnings/i);
  });

  it("allows a second manuscript repair only after improvement and never runs a third repair", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-manuscript-quality-repair2-"));
    process.chdir(root);

    const run = makeRun("run-manuscript-quality-repair2");
    const runDir = await seedRun(root, run);

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildManuscriptRepairTwiceResponses()),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(await exists(path.join(runDir, "paper", "manuscript_repair_1_report.json"))).toBe(true);
    const round1Gate = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_quality_gate_round_1.json"), "utf8")
    ) as { action: string; stop_or_continue_reason: string; allowed_max_passes: number; summary_lines: string[] };
    expect(round1Gate.action, round1Gate.stop_or_continue_reason).toBe("repair");
    expect(round1Gate.allowed_max_passes).toBe(2);
    expect(round1Gate.summary_lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Action:\s+repair/i),
        expect.stringMatching(/Decision stage:\s+post-repair gate after pass 1/i),
        expect.stringMatching(/Allowed max repairs:\s+2;\s+remaining allowed repairs:\s+1/i)
      ])
    );
    expect(await exists(path.join(runDir, "paper", "manuscript_repair_2_report.json"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "manuscript_repair_3_report.json"))).toBe(false);

    const gate = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_quality_gate.json"), "utf8")
    ) as { allowed_max_passes: number; summary_lines: string[] };
    expect(gate.allowed_max_passes).toBe(2);
    expect(gate.summary_lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Action:\s+pass/i),
        expect.stringMatching(/Decision stage:\s+post-repair gate after pass 2/i)
      ])
    );

    const traceRaw = await readFile(path.join(runDir, "paper", "session_trace.json"), "utf8");
    expect(traceRaw).toContain('"stage": "manuscript_repair_1"');
    expect(traceRaw).toContain('"stage": "manuscript_repair_2"');
    expect(traceRaw).not.toContain("manuscript_repair_3");
  });

  it("allows a second repair when the first repair has net improvement but leaves a narrow blocking issue", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-manuscript-quality-narrow-blocking-"));
    process.chdir(root);

    const run = makeRun("run-manuscript-quality-narrow-blocking");
    const runDir = await seedRun(root, run);

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildNarrowBlockingRepairAfterNetImprovementResponses()),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    const round1Gate = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_quality_gate_round_1.json"), "utf8")
    ) as { action: string; improvement_detected: boolean; stop_or_continue_reason: string };
    expect(round1Gate.action, round1Gate.stop_or_continue_reason).toBe("repair");
    expect(round1Gate.improvement_detected).toBe(true);
    expect(round1Gate.stop_or_continue_reason).toMatch(/remaining blocking issues are narrow/i);
    expect(await exists(path.join(runDir, "paper", "manuscript_repair_2_report.json"))).toBe(true);

    const finalGate = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_quality_gate.json"), "utf8")
    ) as { action: string };
    expect(finalGate.action).toBe("pass");
  });

  it("stops after the first repair when the same manuscript-quality issue code repeats and does not run a second repair", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-manuscript-quality-repeat-stop-"));
    process.chdir(root);

    const run = makeRun("run-manuscript-quality-repeat-stop");
    const runDir = await seedRun(root, run);

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient(buildRepeatedLintRepairResponses()),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("manuscript-quality gate failed");
    expect(await exists(path.join(runDir, "paper", "manuscript_repair_1_report.json"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "manuscript_repair_2_report.json"))).toBe(false);

    const gate = JSON.parse(
      await readFile(path.join(runDir, "paper", "manuscript_quality_gate.json"), "utf8")
    ) as { stop_or_continue_reason: string; summary_lines: string[] };
    expect(gate.stop_or_continue_reason).toMatch(/manuscript-quality issue code|did not show a reliable quality improvement/i);
    expect(gate.summary_lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Action:\s+stop/i),
        expect.stringMatching(/Improvement detected:\s+no/i)
      ])
    );
  });

  it("auto-detects workspace template.tex and applies its preamble to paper/main.tex", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-write-paper-template-auto-"));
    process.chdir(root);

    const run = makeRun("run-write-paper-template-auto");
    const runDir = await seedRun(root, run);
    await writeFile(
      path.join(root, "template.tex"),
      [
        "\\documentclass[twocolumn]{article}",
        "\\usepackage{amsmath}",
        "\\newcommand{\\eg}{\\textit{e.g.,}}",
        "\\begin{document}",
        "\\section{Introduction}",
        "\\section{Method}",
        "\\section{Results}",
        "\\end{document}"
      ].join("\n"),
      "utf8"
    );

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient([
        ...buildSessionResponses(),
        buildPolishedManuscriptResponse({
          figures: [
            {
              caption: "Python-rendered comparison of outcome score.",
              bars: [
                { label: "Reference workflow", value: 0.71 },
                { label: "The evaluated workflow", value: 0.76 }
              ]
            }
          ]
        }),
        buildManuscriptReviewResponse({ decision: "pass" }),
        buildManuscriptReviewAuditResponse()
      ]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    const tex = await readFile(path.join(runDir, "paper", "main.tex"), "utf8");
    expect(tex).toContain("\\documentclass[twocolumn]{article}");
    expect(tex).toContain("\\usepackage{amsmath}");
    expect(tex).toContain("\\newcommand{\\eg}{\\textit{e.g.,}}");
    expect(tex).not.toContain("\\usepackage[margin=0.75in]{geometry}");
  });

  it("keeps current ACL template dependencies and uses Python-rendered figure assets in the compiled paper", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-write-paper-acl-template-pdf-"));
    process.chdir(root);

    const run = makeRun("run-write-paper-acl-template-pdf");
    const runDir = await seedRun(root, run);
    await writeFile(
      path.join(root, "template.tex"),
      [
        "\\pdfoutput=1",
        "\\documentclass[11pt]{article}",
        "\\usepackage[review]{xcolor,acl}",
        "\\begin{document}",
        "\\section{Introduction}",
        "\\section{Results}",
        "\\end{document}"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(root, "acl.sty"),
      "% mock ACL style\n\\bibliographystyle{acl_natbib}\n",
      "utf8"
    );
    await writeFile(path.join(root, "acl_natbib.bst"), "ENTRY{}{}{} FUNCTION{default.type}{} READ\n", "utf8");
    await seedMediumScientificRun(run);
    const memory = new RunContextMemory(run.memoryRefs.runContextPath);
    await memory.put(
      "run_brief.raw",
      [
        "# Research Brief",
        "",
        "## Topic",
        "Template-faithful paper writing",
        "",
        "## Manuscript Authors",
        "- authors: AutoLabOS Validation Team",
        "- affiliations: Local Validation Workspace"
      ].join("\n")
    );
    const aci = createPdfBuildAci();
    const staleRunFigure = path.join(runDir, "paper", "figures", "main-result-figure-2.pdf");
    const stalePublicFigure = path.join(
      buildPublicPaperDir(root, run),
      "figures",
      "main-result-figure-2.pdf"
    );
    await mkdir(path.dirname(staleRunFigure), { recursive: true });
    await mkdir(path.dirname(stalePublicFigure), { recursive: true });
    await writeFile(staleRunFigure, "%PDF-1.4 stale run figure\n", "utf8");
    await writeFile(stalePublicFigure, "%PDF-1.4 stale public figure\n", "utf8");

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: true,
          latex_engine: "auto_install"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient([
        ...buildSessionResponses(),
        buildPolishedManuscriptResponse({
          figures: [
            {
              caption: "Python-rendered comparison of outcome score.",
              bars: [
                { label: "Reference workflow", value: 0.71 },
                { label: "The evaluated workflow", value: 0.76 }
              ]
            }
          ]
        }),
        buildManuscriptReviewResponse({ decision: "pass" }),
        buildManuscriptReviewAuditResponse()
      ]),
      codex: {} as any,
      aci: aci.api as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    const tex = await readFile(path.join(runDir, "paper", "main.tex"), "utf8");
    expect(tex).toContain("\\pdfoutput=1");
    expect(tex).toContain("\\usepackage[review]{xcolor,acl}");
    expect(tex).not.toContain("\\bibliographystyle{");
    expect(tex).not.toContain("\\textbf{Keywords:}");
    expect(tex).toContain("\\includegraphics[width=\\columnwidth]{figures/main-result-figure-1.pdf}");
    expect(await exists(path.join(runDir, "paper", "acl.sty"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "acl_natbib.bst"))).toBe(true);
    expect(await exists(path.join(runDir, "paper", "figures", "main-result-figure-1.pdf"))).toBe(true);
    const figureRenderer = await readFile(path.join(runDir, "paper", "figures", "render_paper_figures.py"), "utf8");
    expect(figureRenderer).toContain("matplotlib");
    expect(figureRenderer).toContain("comparison_side");
    expect(figureRenderer).toContain("metric_unit");
    expect(figureRenderer).toContain("subject");
    expect(figureRenderer).toContain("reference");
    expect(figureRenderer).not.toContain("return figure[\"output_pdf\"]");
    expect(await exists(path.join(buildPublicPaperDir(root, run), "figures", "main-result-figure-1.pdf"))).toBe(true);
    expect(await exists(staleRunFigure)).toBe(false);
    expect(await exists(stalePublicFigure)).toBe(false);
    const renderValidation = JSON.parse(
      await readFile(path.join(runDir, "paper", "render_validation.json"), "utf8")
    ) as {
      status: string;
      metrics: {
        final_tex_preserves_template: boolean;
        rendered_figure_asset_count: number;
        final_tex_bibliography_style: string | null;
        repeated_citation_bundle_count: number;
      };
    };
    expect(renderValidation.status).toBe("pass");
    expect(renderValidation.metrics.final_tex_preserves_template).toBe(true);
    expect(renderValidation.metrics.rendered_figure_asset_count).toBeGreaterThan(0);
    expect(renderValidation.metrics.final_tex_bibliography_style).toBeNull();
    expect(renderValidation.metrics.repeated_citation_bundle_count).toBe(0);
  });

  it("does not fall back to inline LaTeX bars when Python figure rendering fails for a compiled template paper", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-write-paper-figure-render-fail-"));
    process.chdir(root);

    const run = makeRun("run-write-paper-figure-render-fail");
    const runDir = await seedRun(root, run);
    await writeFile(
      path.join(root, "template.tex"),
      [
        "\\pdfoutput=1",
        "\\documentclass[11pt]{article}",
        "\\usepackage[review]{acl}",
        "\\begin{document}",
        "\\section{Introduction}",
        "\\section{Results}",
        "\\end{document}"
      ].join("\n"),
      "utf8"
    );
    await writeFile(path.join(root, "acl.sty"), "% mock ACL style\n", "utf8");
    await writeFile(path.join(root, "acl_natbib.bst"), "ENTRY{}{}{} FUNCTION{default.type}{} READ\n", "utf8");
    await seedMediumScientificRun(run);
    const memory = new RunContextMemory(run.memoryRefs.runContextPath);
    await memory.put(
      "run_brief.raw",
      [
        "# Research Brief",
        "",
        "## Topic",
        "Template-faithful paper writing",
        "",
        "## Manuscript Authors",
        "- authors: AutoLabOS Validation Team",
        "- affiliations: Local Validation Workspace"
      ].join("\n")
    );
    const aci = createPdfBuildAci({ failFigureRender: true });

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: true,
          latex_engine: "auto_install"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient([
        ...buildSessionResponses(),
        buildPolishedManuscriptResponse({
          figures: [
            {
              caption: "Python-rendered comparison of outcome score.",
              bars: [
                { label: "Reference workflow", value: 0.71 },
                { label: "The evaluated workflow", value: 0.76 }
              ]
            }
          ]
        }),
        buildManuscriptReviewResponse({ decision: "pass" }),
        buildManuscriptReviewAuditResponse()
      ]),
      codex: {} as any,
      aci: aci.api as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(await exists(path.join(runDir, "paper", "main.tex")), result.error).toBe(true);
    const tex = await readFile(path.join(runDir, "paper", "main.tex"), "utf8");
    expect(tex).toContain("\\usepackage[review]{acl}");
    expect(tex).not.toContain("\\textbf{Keywords:}");
    expect(tex).toContain("\\includegraphics[width=\\columnwidth]{figures/main-result-figure-1.pdf}");
    expect(tex).not.toContain("\\makebox[4.2em][l]");
    expect(result.error).toContain("Main-body result figures must be rendered as Python-generated vector PDF assets");
  });

  it("uses the brief Manuscript Template path when provided", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-write-paper-template-brief-"));
    process.chdir(root);

    const run = makeRun("run-write-paper-template-brief");
    const runDir = await seedRun(root, run);
    await mkdir(path.join(root, "templates"), { recursive: true });
    await writeFile(
      path.join(root, "templates", "neurips.tex"),
      [
        "\\documentclass[twocolumn]{article}",
        "\\usepackage{amssymb}",
        "\\begin{document}",
        "\\section{Introduction}",
        "\\section{Method}",
        "\\section{Results}",
        "\\end{document}"
      ].join("\n"),
      "utf8"
    );
    const memory = new RunContextMemory(run.memoryRefs.runContextPath);
    await memory.put(
      "run_brief.raw",
      [
        "# Research Brief",
        "",
        "## Topic",
        "Template-guided paper writing",
        "",
        "## Manuscript Template",
        "templates/neurips.tex"
      ].join("\n")
    );

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequencedLLMClient([
        ...buildSessionResponses(),
        buildPolishedManuscriptResponse(),
        buildManuscriptReviewResponse({ decision: "pass" }),
        buildManuscriptReviewAuditResponse()
      ]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    const tex = await readFile(path.join(runDir, "paper", "main.tex"), "utf8");
    expect(tex).toContain("\\usepackage{amssymb}");
    expect(tex).not.toContain("\\usepackage[margin=0.75in]{geometry}");
  });

  it("falls back to the built-in preamble and logs when the brief template path is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-write-paper-template-missing-"));
    process.chdir(root);

    const run = makeRun("run-write-paper-template-missing");
    const runDir = await seedRun(root, run);
    const eventStream = new InMemoryEventStream();
    const memory = new RunContextMemory(run.memoryRefs.runContextPath);
    await memory.put(
      "run_brief.raw",
      [
        "# Research Brief",
        "",
        "## Topic",
        "Missing template path",
        "",
        "## Manuscript Template",
        "templates/missing.tex"
      ].join("\n")
    );

    const node = createWritePaperNode({
      config: {
        paper: {
          build_pdf: false
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm: new SequencedLLMClient([
        ...buildSessionResponses(),
        buildPolishedManuscriptResponse(),
        buildManuscriptReviewResponse({ decision: "pass" }),
        buildManuscriptReviewAuditResponse()
      ]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    } as any);

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, result.error).toBe("success");
    const tex = await readFile(path.join(runDir, "paper", "main.tex"), "utf8");
    expect(tex).toContain("\\documentclass[twocolumn]{article}");
    expect(tex).toContain("\\usepackage[margin=0.75in]{geometry}");
    expect(
      eventStream
        .history(200, run.id)
        .some((event) => event.payload?.text === "[write_paper] LaTeX template not found (templates/missing.tex). Using built-in preamble.")
    ).toBe(true);
  });
});
