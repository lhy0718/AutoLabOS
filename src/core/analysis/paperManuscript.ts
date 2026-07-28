import { ObjectiveMetricEvaluation, ObjectiveMetricProfile } from "../objectiveMetric.js";
import { ConstraintProfile } from "../runConstraints.js";
import type { PaperProfileConfig } from "../../types.js";
import type { ParsedLatexTemplate } from "../latex/latexTemplateLoader.js";
import {
  ACL_BIBLIOGRAPHY_STYLE,
  detectAclTemplatePackage
} from "../latex/aclTemplate.js";
import {
  buildSuggestedPaperTitle,
  choosePaperTitle,
  ExperimentPlanArtifact,
  PaperDraft,
  PaperDraftClaim,
  PaperWritingBundle,
  ResultAnalysisArtifact,
  sanitizePaperNarrativeText
} from "./paperWriting.js";
import {
  checkResultsContractCompleteness,
  validateResultsArtifactV2,
  validateResultsPlanV2,
  type ResultsArtifactV2,
  type ResultsComparisonV2,
  type ResultsMetricDefinitionV2,
  type ResultsObservationV2,
  type ResultsPlanV2,
  type ResultsRequiredComparisonV2,
  type ResultsSeriesRole,
  type ResultsSeriesV2
} from "./resultsTableSchema.js";

const STANDARD_SECTION_HEADINGS = [
  "Introduction",
  "Related Work",
  "Method",
  "Results",
  "Discussion",
  "Limitations",
  "Conclusion"
] as const;

const BANNED_HEADINGS = [
  "Research Context",
  "Writing Constraints",
  "Results Overview",
  "Claim Trace"
] as const;

const INTERNAL_ARTIFACT_FILENAMES = [
  "confirmatory_metrics.json",
  "quick_check_metrics.json",
  "metrics.json",
  "result_analysis.json"
] as const;

export const AUTHORED_MAIN_TABLE_SOURCE_REF_ID = "manuscript.authored_main_table";
export const AUTHORED_MAIN_FIGURE_SOURCE_REF_ID = "manuscript.authored_main_figure";
export const AUTHORED_APPENDIX_TABLE_SOURCE_REF_ID = "manuscript.authored_appendix_table";
export const AUTHORED_APPENDIX_FIGURE_SOURCE_REF_ID = "manuscript.authored_appendix_figure";
export const DERIVED_MAIN_TABLE_SOURCE_REF_ID = "manuscript.derived_main_table";
export const DERIVED_MAIN_FIGURE_SOURCE_REF_ID = "manuscript.derived_main_figure";

export interface PaperManuscriptSection {
  heading: string;
  paragraphs: string[];
  source_refs?: PaperSourceRef[];
}

export interface PaperManuscriptVisualRow {
  label: string;
  value: number;
  comparison_id?: string;
  observation_id?: string;
  metric_id?: string;
  series_id?: string;
  series_role?: ResultsSeriesRole;
  comparison_side?: "subject" | "reference" | "difference";
  [metadataKey: string]: string | number | boolean | undefined;
}

export interface PaperManuscriptTable {
  caption: string;
  rows: PaperManuscriptVisualRow[];
  source_refs?: PaperSourceRef[];
  [metadataKey: string]: any;
}

export interface PaperManuscriptFigure {
  caption: string;
  bars: PaperManuscriptVisualRow[];
  source_refs?: PaperSourceRef[];
}

export interface PaperAuthorMetadata {
  authors: string[];
  affiliations?: string[];
  anonymous?: boolean;
}

export interface PaperSourceRef {
  kind: "evidence" | "claim" | "citation" | "artifact";
  id: string;
  label?: string;
}

export interface PaperManuscript {
  title: string;
  abstract: string;
  keywords: string[];
  sections: PaperManuscriptSection[];
  tables?: PaperManuscriptTable[];
  figures?: PaperManuscriptFigure[];
  appendix_sections?: PaperManuscriptSection[];
  appendix_tables?: PaperManuscriptTable[];
  appendix_figures?: PaperManuscriptFigure[];
}

export interface PaperManuscriptStabilizationOptions {
  resultAnalysis?: ResultAnalysisArtifact;
  resultsArtifact?: ResultsArtifactV2;
  resultsPlan?: ResultsPlanV2;
  [optionName: string]: unknown;
}

export interface PaperTraceabilityEntry {
  anchor_id?: string;
  manuscript_section: string;
  paragraph_index: number;
  source_draft_section: string;
  evidence_ids: string[];
  citation_paper_ids: string[];
  claim_ids?: string[];
  source_refs?: PaperSourceRef[];
}

export interface PaperTraceabilityReport {
  paragraphs: PaperTraceabilityEntry[];
}

export interface PaperSubmissionValidationIssue {
  kind:
    | "citation"
    | "placeholder_citation"
    | "evidence_id"
    | "absolute_path"
    | "artifact_filename"
    | "banned_heading"
    | "raw_artifact_text";
  location: string;
  message: string;
  value?: string;
}

export interface PaperSubmissionValidationReport {
  ok: boolean;
  citedPaperIds: string[];
  unresolvedCitationPaperIds: string[];
  issues: PaperSubmissionValidationIssue[];
}

export interface CuratedPaperResultHighlights {
  objectiveSummary?: string;
  selectedDesignTitle?: string;
  topFindings: string[];
  comparisonTakeaways: string[];
  limitations: string[];
  discussionPoints: string[];
  confidenceStatement?: string;
}

interface RawPaperManuscript {
  title?: unknown;
  abstract?: unknown;
  keywords?: unknown;
  sections?: unknown;
  tables?: unknown;
  figures?: unknown;
  appendix_sections?: unknown;
  appendix_tables?: unknown;
  appendix_figures?: unknown;
}

interface RawPaperManuscriptSection {
  heading?: unknown;
  paragraphs?: unknown;
}

interface RawPaperManuscriptParagraph {
  text?: unknown;
}

interface RawPaperManuscriptTable {
  caption?: unknown;
  rows?: unknown;
}

interface RawPaperManuscriptFigure {
  caption?: unknown;
  bars?: unknown;
}

interface RawPaperManuscriptEnvelope {
  revised_manuscript?: unknown;
}

interface RawPaperManuscriptVisualRow {
  label?: unknown;
  value?: unknown;
}

export function parsePaperManuscriptJson(text: string): RawPaperManuscript {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("empty_paper_manuscript_output");
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]+?)```/iu)?.[1]?.trim();
  const candidate = fenced || extractFirstJsonObject(trimmed);
  const parsed = JSON.parse(candidate) as RawPaperManuscript | RawPaperManuscriptEnvelope;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid_paper_manuscript_json");
  }
  const record = parsed as RawPaperManuscriptEnvelope;
  const manuscriptCandidate = record.revised_manuscript;
  if (manuscriptCandidate && typeof manuscriptCandidate === "object" && !Array.isArray(manuscriptCandidate)) {
    return manuscriptCandidate as RawPaperManuscript;
  }
  return parsed as RawPaperManuscript;
}

export function buildPaperPolishPrompt(input: {
  bundle: PaperWritingBundle;
  draft: PaperDraft;
  constraintProfile: ConstraintProfile;
  paperProfile?: PaperProfileConfig;
  objectiveMetricProfile: ObjectiveMetricProfile;
  objectiveEvaluation?: ObjectiveMetricEvaluation;
  resultsArtifact?: ResultsArtifactV2;
  resultsPlan?: ResultsPlanV2;
}): string {
  const primaryComparison = resolvePrimaryComparisonEvidence({
    resultAnalysis: input.bundle.resultAnalysis,
    resultsArtifact: input.resultsArtifact,
    resultsPlan: input.resultsPlan
  });
  const highlights = curatePaperResultHighlights({
    resultAnalysis: input.bundle.resultAnalysis,
    objectiveEvaluation: input.objectiveEvaluation,
    objectiveMetricProfile: input.objectiveMetricProfile,
    experimentPlan: input.bundle.experimentPlan,
    resultsArtifact: input.resultsArtifact,
    resultsPlan: input.resultsPlan
  });

  const citationLibrary = uniqueStrings(
    input.draft.sections.flatMap((section) => section.citation_paper_ids)
  )
    .map((paperId) => input.bundle.corpus.find((item) => item.paper_id === paperId))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .slice(0, 10)
    .map((item) => ({
      paper_id: item.paper_id,
      title: item.title,
      year: item.year,
      venue: item.venue
    }));

  const promptPayload = {
    run: {
      title: input.bundle.runTitle,
      topic: input.bundle.topic,
      objective_metric: input.bundle.objectiveMetric,
      constraints: input.bundle.constraints.map((item) => sanitizePaperNarrativeText(item))
    },
    title_guidance: {
      suggested_paper_title: input.draft.title || buildSuggestedPaperTitle(input.bundle),
      note: "Do not reuse the workflow run title as the paper title. Prefer a method, benchmark, or empirical-study title."
    },
    writing_profile: {
      target_venue: input.constraintProfile.writing.targetVenue,
      tone_hint: input.constraintProfile.writing.toneHint,
      length_hint: input.constraintProfile.writing.lengthHint
    },
    paper_profile: input.paperProfile,
    objective_profile: {
      primary_metric: input.objectiveMetricProfile.primaryMetric,
      target_description: input.objectiveMetricProfile.targetDescription,
      paper_emphasis: input.objectiveMetricProfile.paperEmphasis
    },
    curated_result_highlights: highlights,
    primary_comparison_evidence: primaryComparison.evidence
      ? buildPrimaryComparisonPromptSlice(primaryComparison.evidence)
      : {
          status: primaryComparison.status,
          comparison_claim_allowed: false
        },
    citation_library: citationLibrary,
    grounded_draft: input.draft
  };

  return [
    "Convert the grounded draft into a human-facing submission manuscript.",
    "Return one JSON object with this shape:",
    "{",
    '  "title": "string",',
    '  "abstract": "string",',
    '  "keywords": ["string"],',
    '  "sections": [',
    "    {",
    '      "heading": "Introduction | Related Work | Method | Results | Discussion | Limitations | Conclusion",',
    '      "paragraphs": ["string"]',
    "    }",
    "  ],",
    '  "tables": [{"caption": "string", "rows": [{"label": "string", "value": 0.0}]}],',
    '  "figures": [{"caption": "string", "bars": [{"label": "string", "value": 0.0}]}],',
    '  "appendix_sections": [{"heading": "string", "paragraphs": ["string"]}],',
    '  "appendix_tables": [{"caption": "string", "rows": [{"label": "string", "value": 0.0}]}],',
    '  "appendix_figures": [{"caption": "string", "bars": [{"label": "string", "value": 0.0}]}]',
    "}",
    "",
    "Requirements:",
    "- Choose a title that reads like a human-written methods, benchmark, or empirical study paper title.",
    "- Do not copy the workflow run title verbatim or with only cosmetic edits.",
    "- Write plain academic prose that reads like a human-authored submission draft.",
    "- Preserve the grounded draft's claims conservatively; do not add new results.",
    "- State a quantitative subject/reference comparison only when primary_comparison_evidence has status verified and comparison_claim_allowed true.",
    "- Use the exact metric definition, series roles, observation values, subject/reference links, and primary comparison ID in that evidence.",
    "- Do not select a primary series or reference series from labels, array position, or observed values.",
    "- When primary comparison evidence is unavailable or invalid, remove directional and relative-performance claims and lower the evidence ceiling.",
    "- Evidence-first does not mean short-by-default: maintain enough detail in Method, Results, Discussion, and Limitations to read like a full scientific paper rather than a summary.",
    "- Keep cautious claim strength and explanatory density separate: weaken overstated claims, but do not collapse sections into one-liners.",
    "- Keep the problem framing, related-work positioning, method, main results, and core limitations in the main paper.",
    "- Each major section must play a distinct rhetorical role; do not reuse the same framing sentence across sections.",
    "- Related Work must organize prior work around comparison axes, not just summarize papers one by one.",
    "- Discussion must interpret the results rather than restating the Results section.",
    "- Limitations must name concrete scope limits or evaluation constraints.",
    "- Tables and figures must be informative and non-redundant. If a figure only restates a table more vaguely, omit the figure.",
    "- If you include appendix content, limit it to reader-relevant supporting scientific material such as reproducibility details, supplementary setup details, extended metrics, ablations, additional qualitative examples, or a paper-appropriate prompt/template summary.",
    "- Do not include internal workflow instructions, planning directives, raw artifact references, system prompts, TODO notes, or unresolved author notes anywhere in the manuscript or appendix.",
    "- Downstream routing may move supporting detail such as repeat-level raw metrics, search-space grids, or environment notes into the appendix.",
    "- Do not include evidence IDs, claim IDs, paper IDs, file paths, JSON field names, or internal artifact names in the prose.",
    "- Do not put raw DOI strings, Semantic Scholar hashes, bracketed paper identifiers, evidence identifiers, or citation tokens in paragraph text. Use the manuscript source_refs/citation structure; the renderer will format citations.",
    "- Method must name the executed model/backbone and fixed training settings when they are present in the run artifacts. Do not say exact values are unavailable when the context exposes them.",
    "- Avoid repeated caveat boilerplate such as 'direct supporting evidence is currently limited'; state scope limitations once in Limitations or Discussion instead.",
    "- Do not use the headings Research Context, Writing Constraints, Results Overview, or Claim Trace.",
    "- Keep section headings academic and conventional.",
    "- Avoid log-speak, checklist phrasing, and repeated template language.",
    "- Do not repeat the same framing sentence in multiple sections.",
    "- Do not emit both a table and a figure for nearly identical information unless the figure adds a distinct trend, distribution, or tradeoff insight.",
    "- Do not include internal run instructions, TODO language, or meta commentary.",
    "- Do not inflate claims beyond the available evidence.",
    "- Include at least one informative result table or figure when the payload supports it.",
    "",
    "Context JSON:",
    JSON.stringify(promptPayload, null, 2)
  ].join("\n");
}

export function normalizePaperManuscript(input: {
  raw?: RawPaperManuscript;
  draft: PaperDraft;
  runTitle?: string;
  resultAnalysis?: ResultAnalysisArtifact;
  objectiveEvaluation?: ObjectiveMetricEvaluation;
  objectiveMetricProfile?: ObjectiveMetricProfile;
  experimentPlan?: ExperimentPlanArtifact;
  resultsArtifact?: ResultsArtifactV2;
  resultsPlan?: ResultsPlanV2;
  fallbackManuscript?: PaperManuscript;
}): PaperManuscript {
  const fallback = buildFallbackPaperManuscript({
    draft: input.draft,
    resultAnalysis: input.resultAnalysis,
    objectiveEvaluation: input.objectiveEvaluation,
    objectiveMetricProfile: input.objectiveMetricProfile,
    experimentPlan: input.experimentPlan,
    resultsArtifact: input.resultsArtifact,
    resultsPlan: input.resultsPlan
  });
  const baseManuscript = input.fallbackManuscript || fallback;
  const sections = normalizeManuscriptSections(
    Array.isArray(input.raw?.sections) ? (input.raw?.sections as RawPaperManuscriptSection[]) : []
  );
  const tables = markVisualsAsAuthored(
    normalizeManuscriptTables(
      Array.isArray(input.raw?.tables) ? (input.raw?.tables as RawPaperManuscriptTable[]) : []
    ),
    AUTHORED_MAIN_TABLE_SOURCE_REF_ID
  );
  const figures = markVisualsAsAuthored(
    normalizeManuscriptFigures(
      Array.isArray(input.raw?.figures) ? (input.raw?.figures as RawPaperManuscriptFigure[]) : []
    ),
    AUTHORED_MAIN_FIGURE_SOURCE_REF_ID
  );
  const appendixTables = markVisualsAsAuthored(
    normalizeManuscriptTables(
      Array.isArray(input.raw?.appendix_tables) ? (input.raw?.appendix_tables as RawPaperManuscriptTable[]) : []
    ),
    AUTHORED_APPENDIX_TABLE_SOURCE_REF_ID
  );
  const appendixFigures = markVisualsAsAuthored(
    normalizeManuscriptFigures(
      Array.isArray(input.raw?.appendix_figures) ? (input.raw?.appendix_figures as RawPaperManuscriptFigure[]) : []
    ),
    AUTHORED_APPENDIX_FIGURE_SOURCE_REF_ID
  );
  const appendixSections = normalizeManuscriptSections(
    Array.isArray(input.raw?.appendix_sections) ? (input.raw?.appendix_sections as RawPaperManuscriptSection[]) : [],
    { sanitizeNarrative: false }
  );

  const resolvedBaseSections = preserveSectionSourceRefs(
    sections.length > 0 ? sections : baseManuscript.sections,
    baseManuscript.sections
  );
  const resolvedSections = repairReaderVisibleManuscriptCoherence(
    resolvedBaseSections || baseManuscript.sections
  );
  const resolvedTables = preserveVisualSourceRefs(
    tables.length > 0 ? tables : baseManuscript.tables,
    baseManuscript.tables
  );
  const resolvedFigures = preserveVisualSourceRefs(
    figures.length > 0 ? figures : baseManuscript.figures,
    baseManuscript.figures
  );
  const resolvedAppendixSections = preserveSectionSourceRefs(
    appendixSections.length > 0 ? appendixSections : baseManuscript.appendix_sections,
    baseManuscript.appendix_sections
  );
  const resolvedAppendixTables = repairAppendixTableLabels(preserveVisualSourceRefs(
    appendixTables.length > 0 ? appendixTables : baseManuscript.appendix_tables,
    baseManuscript.appendix_tables
  ));
  const resolvedAppendixFigures = preserveVisualSourceRefs(
    appendixFigures.length > 0 ? appendixFigures : baseManuscript.appendix_figures,
    baseManuscript.appendix_figures
  );

  return stabilizePaperManuscriptForSubmission({
    title: choosePaperTitle({
      candidateTitle: input.raw?.title,
      runTitle: input.runTitle || input.draft.title,
      fallbackTitle: baseManuscript.title
    }),
    abstract: sanitizePaperNarrativeText(input.raw?.abstract) || baseManuscript.abstract,
    keywords:
      normalizeStringArray(input.raw?.keywords).slice(0, 6).length > 0
        ? normalizeStringArray(input.raw?.keywords).slice(0, 6)
        : baseManuscript.keywords,
    sections: resolvedSections || baseManuscript.sections,
    ...(resolvedTables?.length ? { tables: resolvedTables } : {}),
    ...(resolvedFigures?.length ? { figures: resolvedFigures } : {}),
    ...(resolvedAppendixSections?.length ? { appendix_sections: resolvedAppendixSections } : {}),
    ...(resolvedAppendixTables?.length ? { appendix_tables: resolvedAppendixTables } : {}),
    ...(resolvedAppendixFigures?.length ? { appendix_figures: resolvedAppendixFigures } : {})
  }, {
    resultAnalysis: input.resultAnalysis,
    resultsArtifact: input.resultsArtifact,
    resultsPlan: input.resultsPlan
  });
}

export function stabilizePaperManuscriptForSubmission(
  manuscript: PaperManuscript,
  options: PaperManuscriptStabilizationOptions = {}
): PaperManuscript {
  const comparisonResolution = resolvePrimaryComparisonEvidence({
    resultAnalysis: options.resultAnalysis,
    resultsArtifact: options.resultsArtifact,
    resultsPlan: options.resultsPlan
  });
  const sections = enforcePrimaryComparisonClaimCeiling(
    removeReaderVisibleRawProtocolResidue(
      repairReaderVisibleManuscriptCoherence(manuscript.sections)
    ),
    comparisonResolution
  );
  const abstract = enforcePrimaryComparisonAbstract(
    repairSubmissionAbstract(manuscript.abstract),
    comparisonResolution
  );
  const tables = comparisonResolution.evidence
    ? [buildPrimaryComparisonTable(comparisonResolution.evidence)]
    : undefined;
  const figures = comparisonResolution.evidence
    ? [buildPrimaryComparisonFigure(comparisonResolution.evidence)]
    : undefined;
  return {
    ...manuscript,
    title: repairSubmissionTitle(manuscript.title),
    abstract,
    keywords: repairPaperKeywords(manuscript.keywords),
    sections,
    tables,
    figures,
    ...(manuscript.appendix_sections
      ? {
          appendix_sections: enforceSupplementaryComparisonClaimCeiling(
            repairAppendixSections(manuscript.appendix_sections)
          )
        }
      : {}),
    appendix_tables: undefined,
    appendix_figures: undefined
  };
}

type PrimaryComparisonResolutionStatus = "verified" | "unavailable" | "invalid" | "ambiguous";

interface PrimaryComparisonEvidence {
  artifact: ResultsArtifactV2;
  plan: ResultsPlanV2;
  requiredComparison: ResultsRequiredComparisonV2;
  comparison: ResultsComparisonV2;
  metric: ResultsMetricDefinitionV2;
  subjectSeries: ResultsSeriesV2 & { role: ResultsSeriesRole };
  referenceSeries: ResultsSeriesV2 & { role: ResultsSeriesRole };
  subjectObservation: ResultsObservationV2;
  referenceObservation: ResultsObservationV2;
}

interface PrimaryComparisonResolution {
  status: PrimaryComparisonResolutionStatus;
  issues: string[];
  evidence?: PrimaryComparisonEvidence;
}

function resolvePrimaryComparisonEvidence(input: {
  resultAnalysis?: ResultAnalysisArtifact;
  resultsArtifact?: ResultsArtifactV2;
  resultsPlan?: ResultsPlanV2;
}): PrimaryComparisonResolution {
  const report = asPlainRecord(input.resultAnalysis);
  const metrics = asPlainRecord(report.metrics);
  const artifactCandidate = selectContractCandidate(
    input.resultsArtifact,
    [report.results_artifact, metrics.results_artifact]
  );
  const planCandidate = selectContractCandidate(
    input.resultsPlan,
    [report.results_plan, metrics.results_plan]
  );

  if (artifactCandidate.ambiguous || planCandidate.ambiguous) {
    return {
      status: "ambiguous",
      issues: ["Multiple non-equivalent result contracts were supplied."]
    };
  }
  if (artifactCandidate.value === undefined || planCandidate.value === undefined) {
    return {
      status: "unavailable",
      issues: ["A result artifact and an explicit result plan are both required."]
    };
  }

  const artifactValidation = validateResultsArtifactV2(artifactCandidate.value);
  const planValidation = validateResultsPlanV2(planCandidate.value);
  if (!artifactValidation.valid || !planValidation.valid) {
    return {
      status: "invalid",
      issues: [...artifactValidation.issues, ...planValidation.issues]
    };
  }

  const artifact = artifactCandidate.value as ResultsArtifactV2;
  const plan = planCandidate.value as ResultsPlanV2;
  const completeness = checkResultsContractCompleteness(artifact, plan);
  if (!completeness.complete) {
    return { status: "invalid", issues: completeness.issues };
  }

  const primaryComparisonId = cleanString(plan.primary_comparison_id);
  if (!primaryComparisonId) {
    return {
      status: "invalid",
      issues: ["The result plan must explicitly declare primary_comparison_id."]
    };
  }
  const requiredComparison = plan.required_comparisons?.find(
    (item) => item.id === primaryComparisonId
  );
  const comparison = artifact.comparisons.find(
    (item) => item.id === primaryComparisonId
  );
  if (!requiredComparison || !comparison) {
    return {
      status: "invalid",
      issues: ["The declared primary comparison is not present in both the plan and artifact."]
    };
  }

  const metricsById = new Map(artifact.metrics.map((item) => [item.id, item] as const));
  const planMetricsById = new Map(plan.required_metrics.map((item) => [item.id, item] as const));
  const seriesById = new Map(artifact.series.map((item) => [item.id, item] as const));
  const requiredSeriesById = new Map(
    (plan.required_series || []).map((item) => [item.id, item] as const)
  );
  const observationsById = new Map(
    artifact.observations.map((item) => [item.id, item] as const)
  );
  const metric = metricsById.get(requiredComparison.metric_id);
  const planMetric = planMetricsById.get(requiredComparison.metric_id);
  const subjectSeries = seriesById.get(requiredComparison.subject_series_id);
  const referenceSeries = seriesById.get(requiredComparison.reference_series_id);
  const requiredSubjectSeries = requiredSeriesById.get(requiredComparison.subject_series_id);
  const requiredReferenceSeries = requiredSeriesById.get(requiredComparison.reference_series_id);
  const subjectObservation = observationsById.get(comparison.subject_observation_id);
  const referenceObservation = observationsById.get(comparison.reference_observation_id);

  const issues: string[] = [];
  if (requiredComparison.subject_series_id === requiredComparison.reference_series_id) {
    issues.push("The primary comparison must declare distinct subject and reference series.");
  }
  if (comparison.subject_observation_id === comparison.reference_observation_id) {
    issues.push("The primary comparison must link distinct subject and reference observations.");
  }
  if (!metric || !planMetric || !sameMetricDefinition(metric, planMetric)) {
    issues.push("The primary metric definition is missing or inconsistent across the plan and artifact.");
  }
  if (!subjectSeries?.role || !referenceSeries?.role) {
    issues.push("Both primary comparison series must declare explicit roles.");
  }
  if (
    !requiredSubjectSeries
    || !subjectSeries?.role
    || requiredSubjectSeries.role !== subjectSeries.role
  ) {
    issues.push("The subject series role is not explicitly and consistently declared.");
  }
  if (
    !requiredReferenceSeries
    || !referenceSeries?.role
    || requiredReferenceSeries.role !== referenceSeries.role
  ) {
    issues.push("The reference series role is not explicitly and consistently declared.");
  }
  if (!subjectObservation || !referenceObservation) {
    issues.push("The primary comparison does not resolve to two observations.");
  } else {
    const requiredScope = requiredComparison.scope || {};
    if (
      subjectObservation.series_id !== requiredComparison.subject_series_id
      || subjectObservation.metric_id !== requiredComparison.metric_id
      || !sameScalarRecord(subjectObservation.scope, requiredScope)
    ) {
      issues.push("The subject observation does not satisfy the declared primary comparison.");
    }
    if (
      referenceObservation.series_id !== requiredComparison.reference_series_id
      || referenceObservation.metric_id !== requiredComparison.metric_id
      || !sameScalarRecord(referenceObservation.scope, requiredScope)
    ) {
      issues.push("The reference observation does not satisfy the declared primary comparison.");
    }
  }
  if (issues.length > 0) {
    return { status: "invalid", issues };
  }

  return {
    status: "verified",
    issues: [],
    evidence: {
      artifact,
      plan,
      requiredComparison,
      comparison,
      metric: metric!,
      subjectSeries: subjectSeries as ResultsSeriesV2 & { role: ResultsSeriesRole },
      referenceSeries: referenceSeries as ResultsSeriesV2 & { role: ResultsSeriesRole },
      subjectObservation: subjectObservation!,
      referenceObservation: referenceObservation!
    }
  };
}

function selectContractCandidate(
  explicitValue: unknown,
  embeddedValues: unknown[]
): { value?: unknown; ambiguous: boolean } {
  const values = [explicitValue, ...embeddedValues].filter((value) => value !== undefined);
  if (values.length === 0) {
    return { ambiguous: false };
  }
  let signatures: Set<string>;
  try {
    signatures = new Set(values.map((value) => canonicalContractSignature(value)));
  } catch {
    return { ambiguous: true };
  }
  return signatures.size === 1
    ? { value: explicitValue ?? values[0], ambiguous: false }
    : { ambiguous: true };
}

function canonicalContractSignature(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) {
      const normalized = item.map(normalize);
      if (normalized.every((entry) => isRecordWithStringId(entry))) {
        return normalized.slice().sort((left, right) =>
          (left as { id: string }).id.localeCompare((right as { id: string }).id)
        );
      }
      return normalized;
    }
    if (!item || typeof item !== "object") {
      return item;
    }
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalize(nested)])
    );
  };
  return JSON.stringify(normalize(value));
}

function isRecordWithStringId(value: unknown): value is { id: string } {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as { id?: unknown }).id === "string"
  );
}

function sameMetricDefinition(
  left: ResultsMetricDefinitionV2,
  right: ResultsMetricDefinitionV2
): boolean {
  return left.id === right.id
    && cleanString(left.label) === cleanString(right.label)
    && left.direction === right.direction
    && cleanString(left.unit) === cleanString(right.unit);
}

function sameScalarRecord(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): boolean {
  return canonicalContractSignature(left) === canonicalContractSignature(right);
}

function buildPrimaryComparisonPromptSlice(evidence: PrimaryComparisonEvidence): Record<string, unknown> {
  return {
    status: "verified",
    comparison_claim_allowed: true,
    primary_comparison_id: evidence.comparison.id,
    metric: { ...evidence.metric },
    subject_series: {
      id: evidence.subjectSeries.id,
      label: evidence.subjectSeries.label,
      role: evidence.subjectSeries.role
    },
    reference_series: {
      id: evidence.referenceSeries.id,
      label: evidence.referenceSeries.label,
      role: evidence.referenceSeries.role
    },
    subject_observation: { ...evidence.subjectObservation },
    reference_observation: { ...evidence.referenceObservation },
    comparison: { ...evidence.comparison }
  };
}

function buildPrimaryComparisonSentence(evidence: PrimaryComparisonEvidence): string {
  const direction = evidence.metric.direction === "higher_better"
    ? "higher values preferred by the declared metric definition"
    : "lower values preferred by the declared metric definition";
  const metricContext = describePrimaryComparisonMetric(evidence);
  return cleanString(
    `For ${metricContext}, ${evidence.subjectSeries.label} (${evidence.subjectSeries.role} role) recorded ${formatComparisonMeasurement(evidence.subjectObservation.value, evidence.metric.unit)}, while ${evidence.referenceSeries.label} (${evidence.referenceSeries.role} role) recorded ${formatComparisonMeasurement(evidence.referenceObservation.value, evidence.metric.unit)}; the declared subject-minus-reference difference was ${formatComparisonMeasurement(evidence.comparison.delta, evidence.metric.unit)}, with ${direction}.`
  );
}

function formatComparisonMeasurement(value: number, unit: string | undefined): string {
  const rendered = Number(value.toPrecision(12)).toString();
  return cleanString(unit) ? `${rendered} ${cleanString(unit)}` : rendered;
}

function describePrimaryComparisonMetric(evidence: PrimaryComparisonEvidence): string {
  const scope = formatComparisonScope(evidence.requiredComparison.scope);
  return scope ? `${evidence.metric.label} under ${scope}` : evidence.metric.label;
}

function formatComparisonScope(scope: Record<string, unknown> | undefined): string {
  return Object.entries(scope || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${humanizeMetricLabel(key)}=${formatComparisonScalar(value)}`)
    .join(", ");
}

function formatComparisonScalar(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return cleanString(value);
  }
  return String(value);
}

function enforcePrimaryComparisonAbstract(
  abstract: string,
  resolution: PrimaryComparisonResolution
): string {
  const retained = stripEmpiricalComparisonClaims(abstract);
  if (resolution.evidence) {
    return appendSentenceOnce(retained, buildPrimaryComparisonSentence(resolution.evidence));
  }
  return retained || "No directional result is reported from the available evidence.";
}

function enforcePrimaryComparisonClaimCeiling(
  sections: PaperManuscriptSection[],
  resolution: PrimaryComparisonResolution
): PaperManuscriptSection[] {
  const literatureSections = new Set(["related work", "background"]);
  const filtered = sections.map((section) => {
    if (literatureSections.has(normalizeHeadingKey(section.heading))) {
      return section;
    }
    return {
      ...section,
      paragraphs: section.paragraphs
        .map(stripEmpiricalComparisonClaims)
        .filter(Boolean)
    };
  });
  const paragraph = resolution.evidence
    ? buildPrimaryComparisonSentence(resolution.evidence)
    : "No directional result is reported because the available evidence does not identify one fully specified primary comparison.";
  return appendParagraphToSection(filtered, "Results", paragraph, resolution.evidence
    ? buildPrimaryComparisonSourceRefs(resolution.evidence)
    : undefined);
}

function enforceSupplementaryComparisonClaimCeiling(
  sections: PaperManuscriptSection[] | undefined
): PaperManuscriptSection[] | undefined {
  if (!sections) {
    return sections;
  }
  const filtered = sections
    .map((section) => ({
      ...section,
      paragraphs: section.paragraphs.map(stripEmpiricalComparisonClaims).filter(Boolean)
    }))
    .filter((section) => section.paragraphs.length > 0);
  return filtered.length > 0 ? filtered : undefined;
}
function stripEmpiricalComparisonClaims(text: string): string {
  return cleanString(
    splitSubmissionSentences(cleanString(text))
      .filter((sentence) => !isEmpiricalComparisonClaim(sentence))
      .join(" ")
  );
}

function isEmpiricalComparisonClaim(sentence: string): boolean {
  const cleaned = cleanString(sentence);
  const comparisonClaim = /\b(?:compared\s+(?:with|to)|relative\s+to|versus|vs\.?|outperform(?:s|ed|ing)?|underperform(?:s|ed|ing)?|better\s+than|worse\s+than|higher\s+than|lower\s+than|gain(?:s|ed)?|improv(?:e|es|ed|ement|ements|ing)|difference\s+between|subject-minus-reference|delta)\b/iu;
  const pairedMeasurements = /\b(?:recorded|scored|measured|reached|reported)\b.{0,160}\bwhile\b.{0,160}\b(?:recorded|scored|measured|reached|reported)\b/iu;
  const pairedCopulaMeasurements = /\b(?:was|is|at)\s+-?\d+(?:\.\d+)?\b.{0,160}\b(?:while|whereas|and)\b.{0,160}\b(?:was|is|at)\s+-?\d+(?:\.\d+)?\b/iu;
  const numericOrdering = /\b(?:higher|lower|larger|smaller|faster|slower)\b[^.!?]{0,100}\b(?:series|system|method|setting|value|score|result)\b/iu;
  const selectedOutcome = /\b(?:best|leading|winning)[-\s]+(?:series|configuration|setting|result)\b/iu;
  const thresholdOutcome = /\b(?:objective|target|threshold)\b[^.!?]{0,120}\b(?:met|passed|satisfied|exceeded|cleared)\b/iu;
  return comparisonClaim.test(cleaned) || pairedMeasurements.test(cleaned)
    || pairedCopulaMeasurements.test(cleaned) || numericOrdering.test(cleaned)
    || selectedOutcome.test(cleaned) || thresholdOutcome.test(cleaned);
}

function appendSentenceOnce(text: string, sentence: string): string {
  const normalizedSentence = normalizeSubmissionSentenceKey(sentence);
  const existing = splitSubmissionSentences(text);
  return existing.some((item) => normalizeSubmissionSentenceKey(item) === normalizedSentence)
    ? cleanString(text)
    : cleanString([...existing, sentence].join(" "));
}

function appendParagraphToSection(
  sections: PaperManuscriptSection[],
  heading: string,
  paragraph: string,
  sourceRefs?: PaperSourceRef[]
): PaperManuscriptSection[] {
  const targetKey = normalizeHeadingKey(heading);
  const targetIndex = sections.findIndex(
    (section) => normalizeHeadingKey(section.heading) === targetKey
  );
  if (targetIndex >= 0) {
    return sections.map((section, index) => index === targetIndex
      ? {
          ...section,
          paragraphs: appendUniqueParagraph(section.paragraphs, paragraph),
          ...(sourceRefs
            ? { source_refs: mergeSectionSourceRefs(section.source_refs, sourceRefs) }
            : {})
        }
      : section);
  }
  const insertBefore = sections.findIndex((section) =>
    ["discussion", "limitations", "conclusion"].includes(normalizeHeadingKey(section.heading))
  );
  const next = {
    heading,
    paragraphs: [paragraph],
    ...(sourceRefs ? { source_refs: sourceRefs } : {})
  };
  return insertBefore >= 0
    ? [...sections.slice(0, insertBefore), next, ...sections.slice(insertBefore)]
    : [...sections, next];
}

function appendUniqueParagraph(paragraphs: string[], paragraph: string): string[] {
  const key = normalizeSubmissionSentenceKey(paragraph);
  return paragraphs.some((item) => normalizeSubmissionSentenceKey(item) === key)
    ? paragraphs
    : [...paragraphs, paragraph];
}

function buildPrimaryComparisonSourceRefs(
  evidence: PrimaryComparisonEvidence,
  markerId?: string
): PaperSourceRef[] {
  return [
    ...(markerId ? [{ kind: "artifact" as const, id: markerId }] : []),
    { kind: "artifact", id: `results_artifact.comparison:${evidence.comparison.id}` },
    { kind: "artifact", id: `results_artifact.observation:${evidence.subjectObservation.id}` },
    { kind: "artifact", id: `results_artifact.observation:${evidence.referenceObservation.id}` },
    { kind: "artifact", id: `results_plan.primary_comparison:${evidence.comparison.id}` }
  ];
}
function buildPrimaryComparisonTable(evidence: PrimaryComparisonEvidence): PaperManuscriptTable {

  return {
    caption: `Declared primary comparison for ${describePrimaryComparisonMetric(evidence)} (${humanizeDirection(evidence.metric.direction)}).`,
    rows: [
      buildPrimaryComparisonObservationRow(evidence, "subject"),
      buildPrimaryComparisonObservationRow(evidence, "reference"),
      {
        label: "Subject-minus-reference difference",
        value: evidence.comparison.delta,
        comparison_id: evidence.comparison.id,
        metric_id: evidence.metric.id,
        comparison_side: "difference",
        scope_signature: formatComparisonScope(evidence.requiredComparison.scope)
      }
    ],
    source_refs: buildPrimaryComparisonSourceRefs(evidence, DERIVED_MAIN_TABLE_SOURCE_REF_ID)
  };
}

function buildPrimaryComparisonObservationRow(
  evidence: PrimaryComparisonEvidence,
  side: "subject" | "reference"
): PaperManuscriptVisualRow {
  const series = side === "subject" ? evidence.subjectSeries : evidence.referenceSeries;
  const observation = side === "subject"
    ? evidence.subjectObservation
    : evidence.referenceObservation;
  return {
    label: `${series.label} (${series.role} role, ${side})`,
    value: observation.value,
    comparison_id: evidence.comparison.id,
    observation_id: observation.id,
    metric_id: evidence.metric.id,
    series_id: series.id,
    series_role: series.role,
    comparison_side: side,
    scope_signature: formatComparisonScope(evidence.requiredComparison.scope)
  };
}

function buildPrimaryComparisonFigure(evidence: PrimaryComparisonEvidence): PaperManuscriptFigure {
  return {
    caption: `Observations linked by the declared primary comparison for ${describePrimaryComparisonMetric(evidence)}; ${humanizeDirection(evidence.metric.direction)}.`,
    bars: [
      buildPrimaryComparisonObservationRow(evidence, "subject"),
      buildPrimaryComparisonObservationRow(evidence, "reference")
    ],
    source_refs: buildPrimaryComparisonSourceRefs(evidence, DERIVED_MAIN_FIGURE_SOURCE_REF_ID)
  };
}

function humanizeDirection(direction: ResultsMetricDefinitionV2["direction"]): string {
  return direction === "higher_better" ? "higher values preferred" : "lower values preferred";
}
function repairPaperKeywords(keywords: string[]): string[] {

  return uniqueStrings(
    keywords.map((keyword) => humanizeMetricLabel(cleanString(keyword)))
  ).slice(0, 6);
}

function repairReaderVisibleMetricNames(text: string): string {
  return cleanString(text);
}

function sanitizeSubmissionSurfaceText(text: string, context: { sectionHeading?: string } = {}): string {
  let cleaned = repairReaderVisibleMetricNames(sanitizePaperNarrativeText(text))
    .replace(/\bRecovered\s+cached\s+full\s+text(?:\s+describing\s+[^.]{0,160})?\.?/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
  cleaned = stripReaderFacingDraftInstructionSentences(cleaned);
  if (!cleaned || isSubmissionProcessResidue(cleaned)) {
    return "";
  }
  if (/related\s+work/iu.test(context.sectionHeading || "") && isSubmissionRelatedWorkResidue(cleaned)) {
    return "";
  }
  return cleaned;
}

function stripReaderFacingDraftInstructionSentences(text: string): string {
  return cleanString(
    text
      .split(/(?<=[.!?])\s+/u)
      .filter((sentence) => !/\b(?:this draft|available to this draft|final manuscript should cite|final paper version should include|any final paper version should include)\b/iu.test(sentence))
      .filter((sentence) => !/\b(?:final analysis should make clear|those values should be presented|should be presented in the reproducibility supplement)\b/iu.test(sentence))
      .filter((sentence) => !/\b(?:unvalidated notes|stable sources|internal repair guidance|future reporting requirements)\b/iu.test(sentence))
      .filter((sentence) => !/\b(?:until|before)\b[^.!?]{0,220}\breproducibility supplement\b/iu.test(sentence))
      .join(" ")
  );
}

function isSubmissionProcessResidue(text: string): boolean {
  return (
    /\b-\s*(?:Primary|Secondary) metric:/iu.test(text)
    || /\b(?:claim-scope correctness|result-table integrity|paper-readiness (?:audit|inspect)|review gating|result-gating|internal repair guidance)\b/iu.test(text)
    || /\b(?:according to the prompt|this document|the current workflow|submission-quality analysis should|final release tables should)\b/iu.test(text)
    || /\b(?:No-signal boundary|Primary metric|Secondary metric)\s*:/iu.test(text)
    || /…/u.test(text)
  );
}

function isSubmissionRelatedWorkResidue(text: string): boolean {
  return /\b(?:abstract-only fallback|planner-timeout|planner timed out|full-text fallback|supplied notes|source-gathering)\b/iu.test(text)
    || /\b(?:identified in|supplied)[^.]{0,80}\bbrief\b/iu.test(text)
    || /\bcited material\b[^.]{0,160}\bdiffers in domain\b/iu.test(text);
}

function repairSubmissionTitle(title: string): string {
  const cleaned = cleanString(title);
  if (/\b(?:workflow|audit|paper[- ]?readiness|result[- ]?gating)\b/iu.test(cleaned)) {
    return "A Governed Experimental Study Under a Fixed Resource Budget";
  }
  return cleaned;
}

function normalizeSubmissionParagraphKey(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/\\cite\{[^}]*\}/giu, " ")
    .replace(/[^a-z0-9]+/giu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
}

function normalizeSubmissionSentenceKey(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/\\cite\{[^}]*\}/giu, " ")
    .replace(/[^a-z0-9]+/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function splitSubmissionSentences(text: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== "." && char !== "!" && char !== "?") {
      continue;
    }
    const previous = index > 0 ? text[index - 1] : "";
    const next = index + 1 < text.length ? text[index + 1] : "";
    if (char === "." && /\d/u.test(previous) && /\d/u.test(next)) {
      continue;
    }
    const atEnd = index + 1 >= text.length;
    const followedByWhitespace = /\s/u.test(next);
    if (!atEnd && !followedByWhitespace) {
      continue;
    }
    const sentence = text.slice(start, index + 1).trim();
    if (sentence) {
      sentences.push(sentence);
    }
    start = index + 1;
  }
  const tail = text.slice(start).trim();
  if (tail) {
    sentences.push(tail);
  }
  return sentences.length > 0 ? sentences : [text.trim()].filter(Boolean);
}

function pruneRepeatedSubmissionSentences(text: string, seenSentenceKeys: Set<string>): string {
  const sentences = splitSubmissionSentences(text);
  const retained: string[] = [];
  for (const sentence of sentences) {
    const key = normalizeSubmissionSentenceKey(sentence);
    const shouldTrack = key.length >= 80;
    if (shouldTrack && seenSentenceKeys.has(key)) {
      continue;
    }
    retained.push(sentence);
    if (shouldTrack) {
      seenSentenceKeys.add(key);
    }
  }
  return cleanString(retained.join(" "));
}

function repairSubmissionAbstract(abstract: string): string {
  return repairReaderVisibleMetricNames(cleanString(abstract));
}

function repairReaderVisibleManuscriptCoherence(sections: PaperManuscriptSection[]): PaperManuscriptSection[] {
  return sections.map((section) => {
    const headingKey = normalizeHeadingKey(section.heading);
    let paragraphs = section.paragraphs.map((paragraph) =>
      normalizeReaderVisibleParagraph(paragraph)
    ).filter(Boolean);
    paragraphs = pruneReaderFacingRedundantParagraphs(paragraphs);
    paragraphs = paragraphs
      .map((paragraph) => sanitizeSubmissionSurfaceText(paragraph, { sectionHeading: section.heading }))
      .filter((paragraph) => !isReaderVisibleRawProtocolResidue(headingKey, paragraph))
      .filter(Boolean);
    return {
      ...section,
      paragraphs
    };
  });
}

function removeReaderVisibleRawProtocolResidue(sections: PaperManuscriptSection[]): PaperManuscriptSection[] {
  return sections.map((section) => {
    const headingKey = normalizeHeadingKey(section.heading);
    return {
      ...section,
      paragraphs: section.paragraphs.filter((paragraph) => !isReaderVisibleRawProtocolResidue(headingKey, paragraph))
    };
  });
}

function isReaderVisibleRawProtocolResidue(headingKey: string, paragraph: string): boolean {
  const cleaned = cleanString(paragraph);
  if (!cleaned) {
    return true;
  }
  if (
    /^Evidence accounting:/iu.test(cleaned)
    || /\b(?:this draft|available to this draft|final manuscript should cite|final paper version should include|any final paper version should include)\b/iu.test(cleaned)
    || /\b(?:final analysis should make clear|those values should be presented|should be presented in the reproducibility supplement)\b/iu.test(cleaned)
    || /\b(?:unvalidated notes|stable sources|internal repair guidance|future reporting requirements)\b/iu.test(cleaned)
  ) {
    return true;
  }
  return (
    headingKey === "method"
    && (
      /\bEvaluation spans Training:/iu.test(cleaned)
      || /\bPreprocessing follows this order:/iu.test(cleaned)
      || /\bThe protocol records\b/iu.test(cleaned)
      || /\bPaper-scale evidence floor:/iu.test(cleaned)
      || /\bCanonical-reference gate:/iu.test(cleaned)
      || /\b[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}\b/u.test(cleaned)
    )
  );
}

function normalizeReaderVisibleParagraph(paragraph: string): string {
  return repairReaderVisibleMetricNames(paragraph);
}

function pruneReaderFacingRedundantParagraphs(paragraphs: string[]): string[] {
  const result: string[] = [];
  for (const paragraph of paragraphs) {
    const cleaned = cleanString(paragraph);
    if (!cleaned || result.some((existing) => areReaderFacingParagraphsRedundant(existing, cleaned))) {
      continue;
    }
    result.push(cleaned);
  }
  return result;
}

function areReaderFacingParagraphsRedundant(left: string, right: string): boolean {
  const leftTokens = readerFacingContentTokenSet(left);
  const rightTokens = readerFacingContentTokenSet(right);
  if (leftTokens.size < 10 || rightTokens.size < 10) {
    return false;
  }
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.min(leftTokens.size, rightTokens.size) >= 0.62;
}

function readerFacingContentTokenSet(value: string): Set<string> {
  const stopwords = new Set([
    "about", "across", "after", "again", "against", "also", "because", "before", "being", "between",
    "could", "current", "does", "from", "have", "into", "more", "rather", "reported", "should",
    "study", "that", "their", "there", "these", "this", "those", "under", "while", "with", "within"
  ]);
  return new Set(
    cleanString(value)
      .toLowerCase()
      .replace(/[^a-z0-9./-]+/gu, " ")
      .split(/\s+/u)
      .map((token) => token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, ""))
      .filter((token) => token.length >= 4 && !stopwords.has(token))
  );
}

function repairAppendixSections(sections: PaperManuscriptSection[]): PaperManuscriptSection[] | undefined {
  const repaired = sections
    .filter((section) => !isAppendixPlanningSectionHeading(section.heading))
    .map((section) => ({
      ...section,
      paragraphs: pruneReaderFacingRedundantParagraphs(
        section.paragraphs
          .map((paragraph) => sanitizeSubmissionSurfaceText(cleanString(paragraph), { sectionHeading: section.heading }))
          .filter((paragraph) => paragraph && !isReaderVisibleRawProtocolResidue(normalizeHeadingKey(section.heading), paragraph))
      )
    }))
    .filter((section) => section.paragraphs.length > 0);
  return repaired.length > 0 ? repaired : undefined;
}

function isAppendixPlanningSectionHeading(heading: string): boolean {
  const normalized = cleanString(heading);
  return (
    /\b(?:recommended|proposed|suggested)\b.*\b(?:addition|change|follow[- ]?up|improvement|reporting|revision)s?\b/iu.test(normalized)
    || /\bcomplete reproducibility appendix\b/iu.test(normalized)
  );
}

function repairAppendixTableLabels(
  tables: PaperManuscriptTable[] | undefined
): PaperManuscriptTable[] | undefined {
  if (!tables) {
    return tables;
  }
  return tables
    .map((table) => ({
      ...table,
      caption: stripEmpiricalComparisonClaims(sanitizeSubmissionSurfaceText(table.caption)),
      rows: table.rows.map((row) => ({
        ...row,
        label: cleanString(row.label)
      })).filter((row) => row.label)
    }))
    .filter((table) => table.caption && table.rows.length > 0);
}

function asPlainRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mergeSectionSourceRefs(
  existing: PaperSourceRef[] | undefined,
  next: PaperSourceRef[]
): PaperSourceRef[] {
  const seen = new Set<string>();
  const merged: PaperSourceRef[] = [];
  for (const ref of [...(existing || []), ...next]) {
    const key = `${ref.kind}:${ref.id}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(ref);
    }
  }
  return merged;
}

function selectRenderedSubmissionParagraphs(
  _heading: string,
  entries: { text: string; citationPaperIds: string[] }[]
): { text: string; citationPaperIds: string[] }[] {
  const selected: { text: string; citationPaperIds: string[] }[] = [];
  for (const entry of entries) {
    if (selected.some((existing) => areReaderFacingParagraphsRedundant(existing.text, entry.text))) {
      continue;
    }
    selected.push(entry);
  }
  return selected;
}

export function buildFallbackPaperManuscript(input: {
  draft: PaperDraft;
  resultAnalysis?: ResultAnalysisArtifact;
  objectiveEvaluation?: ObjectiveMetricEvaluation;
  objectiveMetricProfile?: ObjectiveMetricProfile;
  experimentPlan?: ExperimentPlanArtifact;
  resultsArtifact?: ResultsArtifactV2;
  resultsPlan?: ResultsPlanV2;
}): PaperManuscript {
  const primaryComparison = resolvePrimaryComparisonEvidence({
    resultAnalysis: input.resultAnalysis,
    resultsArtifact: input.resultsArtifact,
    resultsPlan: input.resultsPlan
  });
  const highlights = curatePaperResultHighlights({
    resultAnalysis: input.resultAnalysis,
    objectiveEvaluation: input.objectiveEvaluation,
    objectiveMetricProfile: input.objectiveMetricProfile,
    experimentPlan: input.experimentPlan,
    resultsArtifact: input.resultsArtifact,
    resultsPlan: input.resultsPlan
  });

  const sections = input.draft.sections
    .map((section) => ({
      heading: cleanString(section.heading),
      paragraphs: section.paragraphs
        .map((paragraph) => cleanString(paragraph.text))
        .filter(Boolean)
        .slice(0, 2)
    }))
    .filter((section) => section.heading && section.paragraphs.length > 0)
    .map((section) => ({
      heading: section.heading,
      paragraphs:
        normalizeHeadingKey(section.heading) === "results"
          ? enrichResultsParagraphs(section.paragraphs, highlights)
          : section.paragraphs
    }));

  const normalizedSections = sections.length > 0 ? sections : buildDefaultSections(highlights);
  const discussionSection = buildFallbackDiscussionSection(normalizedSections, highlights);
  const withDiscussion =
    discussionSection &&
    !normalizedSections.some(
      (section) => normalizeHeadingKey(section.heading) === normalizeHeadingKey(discussionSection.heading)
    )
      ? [...normalizedSections, discussionSection]
      : normalizedSections;
  const visuals = buildAutomaticManuscriptVisuals(primaryComparison.evidence);
  const appendix = buildAutomaticManuscriptAppendix(input.resultAnalysis);

  return stabilizePaperManuscriptForSubmission({
    title: input.draft.title,
    abstract: input.draft.abstract,
    keywords: input.draft.keywords.slice(0, 6),
    sections: sortSections(withDiscussion),
    ...(visuals.tables.length > 0 ? { tables: visuals.tables } : {}),
    ...(visuals.figures.length > 0 ? { figures: visuals.figures } : {}),
    ...(appendix.sections.length > 0 ? { appendix_sections: appendix.sections } : {}),
    ...(appendix.tables.length > 0 ? { appendix_tables: appendix.tables } : {})
  }, {
    resultAnalysis: input.resultAnalysis,
    resultsArtifact: input.resultsArtifact,
    resultsPlan: input.resultsPlan
  });
}

export function buildPaperTraceability(input: {
  draft: PaperDraft;
  manuscript: PaperManuscript;
}): PaperTraceabilityReport {
  const sectionByHeading = new Map(
    input.draft.sections.map((section) => [normalizeHeadingKey(section.heading), section] as const)
  );
  const aggregateGrounding = buildAggregateDraftGrounding(input.draft);

  return {
    paragraphs: [
      {
        anchor_id: buildParagraphAnchorId("Title", 0),
        manuscript_section: "Title",
        paragraph_index: 0,
        source_draft_section: "",
        evidence_ids: aggregateGrounding.evidenceIds,
        citation_paper_ids: aggregateGrounding.citationPaperIds,
        ...(aggregateGrounding.sourceRefs ? { source_refs: aggregateGrounding.sourceRefs } : {}),
        ...(aggregateGrounding.claimIds.length > 0 ? { claim_ids: aggregateGrounding.claimIds } : {})
      },
      {
        anchor_id: buildParagraphAnchorId("Abstract", 0),
        manuscript_section: "Abstract",
        paragraph_index: 0,
        source_draft_section: "",
        evidence_ids: aggregateGrounding.evidenceIds,
        citation_paper_ids: aggregateGrounding.citationPaperIds,
        ...(aggregateGrounding.sourceRefs ? { source_refs: aggregateGrounding.sourceRefs } : {}),
        ...(aggregateGrounding.claimIds.length > 0 ? { claim_ids: aggregateGrounding.claimIds } : {})
      },
      ...buildTraceabilityEntriesForSectionCollection({
        sections: input.manuscript.sections,
        draft: input.draft,
        sectionByHeading,
        anchorNamespace: "main"
      }),
      ...buildTraceabilityEntriesForSectionCollection({
        sections: input.manuscript.appendix_sections || [],
        draft: input.draft,
        sectionByHeading,
        anchorNamespace: "appendix"
      })
    ]
  };
}

export function buildPaperSubmissionValidation(input: {
  manuscript: PaperManuscript;
  tex: string;
  traceability: PaperTraceabilityReport;
  citationKeysByPaperId: Map<string, string>;
  unresolvedCitationPaperIds?: string[];
}): PaperSubmissionValidationReport {
  const issues: PaperSubmissionValidationIssue[] = [];
  const citedPaperIds = uniqueStrings(
    input.traceability.paragraphs.flatMap((paragraph) => paragraph.citation_paper_ids)
  );
  const unresolvedCitationPaperIds = uniqueStrings([
    ...citedPaperIds.filter((paperId) => !input.citationKeysByPaperId.has(paperId)),
    ...(input.unresolvedCitationPaperIds || [])
  ]);

  for (const heading of input.manuscript.sections.map((section) => section.heading)) {
    if (isBannedHeading(heading)) {
      issues.push({
        kind: "banned_heading",
        location: "manuscript.section.heading",
        message: "Final manuscript uses a banned debug-style heading.",
        value: heading
      });
    }
  }

  validateSubmissionChunk(input.manuscript.title, "manuscript.title", issues);
  validateSubmissionChunk(input.manuscript.abstract, "manuscript.abstract", issues);
  for (const section of input.manuscript.sections) {
    for (let index = 0; index < section.paragraphs.length; index += 1) {
      validateSubmissionChunk(
        section.paragraphs[index],
        `manuscript.sections.${section.heading}.paragraphs.${index}`,
        issues
      );
    }
  }
  for (const section of input.manuscript.appendix_sections || []) {
    for (let index = 0; index < section.paragraphs.length; index += 1) {
      validateSubmissionChunk(
        section.paragraphs[index],
        `manuscript.appendix_sections.${section.heading}.paragraphs.${index}`,
        issues
      );
    }
  }
  validateSubmissionChunk(input.tex, "paper.main.tex", issues);

  for (const paperId of unresolvedCitationPaperIds) {
    issues.push({
      kind: "citation",
      location: "traceability",
      message: "A cited paper ID does not resolve to a bibliography key.",
      value: paperId
    });
  }

  return {
    ok: issues.length === 0,
    citedPaperIds,
    unresolvedCitationPaperIds,
    issues
  };
}

export function renderSubmissionPaperTex(input: {
  manuscript: PaperManuscript;
  traceability: PaperTraceabilityReport;
  citationKeysByPaperId: Map<string, string>;
  template?: string;
  paperProfile?: PaperProfileConfig;
  parsedTemplate?: ParsedLatexTemplate | null;
  authorMetadata?: PaperAuthorMetadata | null;
  includeKeywords?: boolean;
  figureRenderMode?: "latex_bars" | "external_pdf";
}): string {
  const sectionCitationMap = new Map<string, string[]>();
  for (const item of input.traceability.paragraphs) {
    sectionCitationMap.set(
      buildTraceabilityKey(item.manuscript_section, item.paragraph_index),
      item.citation_paper_ids
    );
  }

  const columnCount = input.parsedTemplate?.columnLayout ?? (input.paperProfile?.column_count ?? 2);
  const docClassOptions = columnCount === 2 ? "[twocolumn]" : "";
  const renderedAuthor = renderAuthorCommand(input.authorMetadata);
  const supportPackages = buildSubmissionSupportPackages(input.parsedTemplate);
  const renderedAbstract = sanitizeSubmissionSurfaceText(input.manuscript.abstract);

  const lines = input.parsedTemplate
    ? [
        ...(input.parsedTemplate.preDocumentPreamble ? [input.parsedTemplate.preDocumentPreamble] : []),
        input.parsedTemplate.documentClass || resolveDocumentClass(input.template).replace("{article}", `${docClassOptions}{article}`),
        input.parsedTemplate.preamble,
        ...supportPackages,
        "\\title{" + latexEscape(input.manuscript.title) + "}",
        ...(renderedAuthor ? [renderedAuthor] : []),
        "\\date{}",
        "\\begin{document}",
        "\\maketitle",
        "\\begin{abstract}",
        latexEscape(renderedAbstract),
        "\\end{abstract}"
      ]
    : [
        resolveDocumentClass(input.template).replace("{article}", `${docClassOptions}{article}`),
        "\\usepackage[T1]{fontenc}",
        columnCount === 2
          ? "\\usepackage[margin=0.75in]{geometry}"
          : "\\usepackage[margin=1in]{geometry}",
        "\\usepackage{graphicx}",
        ...supportPackages,
        "\\title{" + latexEscape(input.manuscript.title) + "}",
        ...(renderedAuthor ? [renderedAuthor] : []),
        "\\date{}",
        "\\begin{document}",
        "\\maketitle",
        "\\begin{abstract}",
        latexEscape(renderedAbstract),
        "\\end{abstract}"
      ];

  const shouldIncludeKeywords = input.includeKeywords ?? !input.parsedTemplate;
  if (shouldIncludeKeywords && input.manuscript.keywords.length > 0) {
    lines.push(`\\noindent\\textbf{Keywords:} ${latexEscape(input.manuscript.keywords.join(", "))}`);
    lines.push("");
  }

  let visualsRendered = false;
  const renderedDocumentSentences = new Set<string>();
  for (const section of input.manuscript.sections) {
    lines.push(`\\section{${latexEscape(section.heading)}}`);
    const renderedSectionParagraphs = new Set<string>();
    for (let index = 0; index < section.paragraphs.length; index += 1) {
      const paragraph = section.paragraphs[index];
      const citationPaperIds = shouldRenderSubmissionCitationsForParagraph(section.heading, paragraph, index)
        ? sectionCitationMap.get(buildTraceabilityKey(section.heading, index)) || []
        : [];
      const renderedParagraph = pruneRepeatedSubmissionSentences(
        sanitizeSubmissionSurfaceText(paragraph, { sectionHeading: section.heading }),
        renderedDocumentSentences
      );
      if (!renderedParagraph) {
        continue;
      }
      const paragraphKey = normalizeSubmissionParagraphKey(renderedParagraph);
      if (renderedSectionParagraphs.has(paragraphKey)) {
        continue;
      }
      renderedSectionParagraphs.add(paragraphKey);
      lines.push(renderSubmissionParagraph(renderedParagraph, citationPaperIds, input.citationKeysByPaperId));
      lines.push("");
    }

    if (!visualsRendered && normalizeHeadingKey(section.heading) === "results") {
      lines.push(...renderSubmissionVisuals(input.manuscript, input.figureRenderMode));
      visualsRendered = true;
    }
  }

  if (!visualsRendered) {
    lines.push(...renderSubmissionVisuals(input.manuscript, input.figureRenderMode));
  }

  const bibliographyStyle = resolveSubmissionBibliographyStyle(input);
  if (bibliographyStyle) {
    lines.push(`\\bibliographystyle{${bibliographyStyle}}`);
  }
  lines.push("\\bibliography{references}");
  if (
    (input.manuscript.appendix_sections || []).length > 0 ||
    (input.manuscript.appendix_tables || []).length > 0 ||
    (input.manuscript.appendix_figures || []).length > 0
  ) {
    lines.push("\\appendix");
    lines.push("");
    for (const section of input.manuscript.appendix_sections || []) {
      lines.push(`\\section{${latexEscape(section.heading)}}`);
      const renderedSectionParagraphs = new Set<string>();
      for (const paragraph of section.paragraphs) {
        const renderedParagraph = sanitizeSubmissionSurfaceText(paragraph, { sectionHeading: section.heading });
        if (!renderedParagraph) {
          continue;
        }
        const paragraphKey = normalizeSubmissionParagraphKey(renderedParagraph);
        if (renderedSectionParagraphs.has(paragraphKey)) {
          continue;
        }
        renderedSectionParagraphs.add(paragraphKey);
        lines.push(latexEscape(renderedParagraph));
        lines.push("");
      }
    }
    lines.push(
      ...renderVisualCollection(
        input.manuscript.appendix_tables || [],
        input.manuscript.appendix_figures || []
      )
    );
  }
  lines.push("\\end{document}");
  return lines.join("\n");
}

export function curatePaperResultHighlights(input: {
  resultAnalysis?: ResultAnalysisArtifact;
  objectiveEvaluation?: ObjectiveMetricEvaluation;
  objectiveMetricProfile?: ObjectiveMetricProfile;
  experimentPlan?: ExperimentPlanArtifact;
  resultsArtifact?: ResultsArtifactV2;
  resultsPlan?: ResultsPlanV2;
}): CuratedPaperResultHighlights {
  const primaryComparison = resolvePrimaryComparisonEvidence({
    resultAnalysis: input.resultAnalysis,
    resultsArtifact: input.resultsArtifact,
    resultsPlan: input.resultsPlan
  });
  const candidateObjectiveSummary =
    cleanString(input.objectiveEvaluation?.summary)
    || cleanString(input.resultAnalysis?.objective_metric?.evaluation?.summary)
    || cleanString(input.objectiveMetricProfile?.targetDescription);
  const objectiveSummary = candidateObjectiveSummary && !isEmpiricalComparisonClaim(candidateObjectiveSummary)
    ? candidateObjectiveSummary
    : primaryComparison.evidence
      ? buildPrimaryComparisonSentence(primaryComparison.evidence)
      : undefined;
  const confidenceStatement = cleanString(input.resultAnalysis?.synthesis?.confidence_statement);


  return {
    objectiveSummary,
    selectedDesignTitle:
      cleanString(input.resultAnalysis?.plan_context?.selected_design?.title)
      || cleanString(input.experimentPlan?.selectedTitle),
    topFindings: takeSafeStrings(
      (input.resultAnalysis?.primary_findings || []).filter(
        (item) => !isEmpiricalComparisonClaim(cleanString(item))
      ),
      3
    ),
    comparisonTakeaways: primaryComparison.evidence
      ? [buildPrimaryComparisonSentence(primaryComparison.evidence)]
      : [],
    limitations: takeSafeStrings(
      (input.resultAnalysis?.limitations || []).filter(
        (item) => !isEmpiricalComparisonClaim(cleanString(item))
      ), 2),
    discussionPoints: takeSafeStrings(
      (input.resultAnalysis?.synthesis?.discussion_points || []).filter(
        (item) => !isEmpiricalComparisonClaim(cleanString(item))
      ),
      2
    ),
    confidenceStatement: confidenceStatement && !isEmpiricalComparisonClaim(confidenceStatement)
      ? confidenceStatement
      : undefined
  };
}

function normalizeManuscriptSections(
  sections: RawPaperManuscriptSection[],
  options: { sanitizeNarrative?: boolean } = {}
): PaperManuscriptSection[] {
  return sections
    .map((section) => {
      const heading = cleanString(section?.heading);
      const paragraphs = normalizeManuscriptParagraphs(section?.paragraphs, options);
      if (!heading || paragraphs.length === 0) {
        return undefined;
      }
      return {
        heading,
        paragraphs
      };
    })
    .filter((section): section is PaperManuscriptSection => Boolean(section))
    .slice(0, 10);
}

function normalizeManuscriptParagraphs(
  value: unknown,
  options: { sanitizeNarrative?: boolean } = {}
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const sanitizeNarrative = options.sanitizeNarrative !== false;
  return value
    .map((paragraph) => {
      if (typeof paragraph === "string") {
        return sanitizeNarrative ? sanitizePaperNarrativeText(paragraph) : cleanString(paragraph);
      }
      if (!paragraph || typeof paragraph !== "object" || Array.isArray(paragraph)) {
        return "";
      }
      const text = (paragraph as RawPaperManuscriptParagraph).text;
      return sanitizeNarrative ? sanitizePaperNarrativeText(text) : cleanString(text);
    })
    .filter(Boolean)
    .slice(0, 6);
}

function normalizeManuscriptTables(
  tables: RawPaperManuscriptTable[]
): PaperManuscriptTable[] {
  return tables
    .map((table) => {
      const caption = cleanString(table?.caption);
      const rows = normalizeVisualRows(table?.rows);
      if (!caption || !visualRowsMeetQualityGate(rows)) {
        return undefined;
      }
      return {
        caption,
        rows: rows.slice(0, 8)
      };
    })
    .filter((table): table is PaperManuscriptTable => Boolean(table))
    .slice(0, 2);
}

function normalizeManuscriptFigures(
  figures: RawPaperManuscriptFigure[]
): PaperManuscriptFigure[] {
  return figures
    .map((figure) => {
      const caption = cleanString(figure?.caption);
      const bars = normalizeVisualRows(figure?.bars);
      if (!caption || !visualRowsMeetQualityGate(bars)) {
        return undefined;
      }
      return {
        caption,
        bars: bars.slice(0, 8)
      };
    })
    .filter((figure): figure is PaperManuscriptFigure => Boolean(figure))
    .slice(0, 2);
}

function preserveSectionSourceRefs<T extends PaperManuscriptSection>(
  sections: T[] | undefined,
  fallbackSections: PaperManuscriptSection[] | undefined
): T[] | undefined {
  if (!sections?.length) {
    return sections;
  }
  const fallbackByHeading = new Map(
    (fallbackSections || []).map((section) => [normalizeHeadingKey(section.heading), section] as const)
  );
  return sections.map((section) => {
    const fallback = fallbackByHeading.get(normalizeHeadingKey(section.heading));
    return fallback?.source_refs?.length ? { ...section, source_refs: fallback.source_refs } : section;
  });
}

function preserveVisualSourceRefs<T extends PaperManuscriptTable | PaperManuscriptFigure>(
  items: T[] | undefined,
  fallbackItems: Array<PaperManuscriptTable | PaperManuscriptFigure> | undefined
): T[] | undefined {
  if (!items?.length) {
    return items;
  }
  return items.map((item, index) => {
    const fallback = fallbackItems?.[index];
    return fallback?.source_refs?.length ? { ...item, source_refs: fallback.source_refs } : item;
  });
}

function markVisualsAsAuthored<T extends PaperManuscriptTable | PaperManuscriptFigure>(
  items: T[],
  markerId: string
): T[] {
  if (!items.length) {
    return items;
  }
  return items.map((item) => ({
    ...item,
    source_refs: item.source_refs?.some((ref) => ref.kind === "artifact" && ref.id === markerId)
      ? item.source_refs
      : [{ kind: "artifact" as const, id: markerId }, ...(item.source_refs || [])]
  }));
}

function normalizeVisualRows(value: unknown): PaperManuscriptVisualRow[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        return undefined;
      }
      const raw = row as RawPaperManuscriptVisualRow;
      const label = cleanString(raw.label);
      const numericValue = normalizeNumber(raw.value);
      if (!label || typeof numericValue !== "number") {
        return undefined;
      }
      const humanizedLabel = humanizeMetricLabel(label);
      if (!isHumanReadableMetricLabel(humanizedLabel)) {
        return undefined;
      }
      return {
        label: humanizedLabel,
        value: numericValue
      };
    })
    .filter((row): row is PaperManuscriptVisualRow => Boolean(row));
}

function enrichResultsParagraphs(
  paragraphs: string[],
  highlights: CuratedPaperResultHighlights
): string[] {
  if (paragraphs.length >= 2 || (!highlights.topFindings.length && !highlights.comparisonTakeaways.length)) {
    return paragraphs;
  }
  const summaryBits = [
    ...highlights.topFindings.slice(0, 2),
    ...highlights.comparisonTakeaways.slice(0, 1),
    ...highlights.limitations.slice(0, 1).map((item) => `A key limitation is that ${lowercaseLeadingWord(item)}`)
  ];
  if (summaryBits.length === 0) {
    return paragraphs;
  }
  return [...paragraphs, summaryBits.join(" ")];
}

function buildDefaultSections(
  highlights: CuratedPaperResultHighlights
): PaperManuscriptSection[] {
  return [
    {
      heading: "Introduction",
      paragraphs: ["This paper presents a grounded summary of the current automated research workflow and its main empirical takeaways."]
    },
    {
      heading: "Method",
      paragraphs: [
        highlights.selectedDesignTitle
          ? `The study centers on the ${highlights.selectedDesignTitle} design and synthesizes evidence from the workflow's literature, hypothesis, and experiment artifacts.`
          : "The study synthesizes evidence from the workflow's literature, hypothesis, and experiment artifacts."
      ]
    },
    {
      heading: "Results",
      paragraphs: [
        highlights.objectiveSummary ||
          "The available results provide a cautious summary of the current objective-oriented evaluation."
      ]
    },
    {
      heading: "Conclusion",
      paragraphs: ["The current manuscript remains conservative and grounded in the available workflow evidence."]
    }
  ];
}

function buildFallbackDiscussionSection(
  sections: PaperManuscriptSection[],
  highlights: CuratedPaperResultHighlights
): PaperManuscriptSection | undefined {
  if (
    sections.some((section) => normalizeHeadingKey(section.heading) === "discussion") ||
    (highlights.discussionPoints.length === 0 && highlights.limitations.length === 0)
  ) {
    return undefined;
  }

  const sentences = [
    ...highlights.discussionPoints,
    ...highlights.limitations.map((item) => `A notable limitation is that ${lowercaseLeadingWord(item)}`)
  ].slice(0, 2);

  if (sentences.length === 0) {
    return undefined;
  }

  return {
    heading: "Discussion",
    paragraphs: [sentences.join(" ")]
  };
}

function sortSections(sections: PaperManuscriptSection[]): PaperManuscriptSection[] {
  const order = new Map(STANDARD_SECTION_HEADINGS.map((heading, index) => [normalizeHeadingKey(heading), index] as const));
  return sections
    .slice(0, 6)
    .sort(
      (left, right) =>
        (order.get(normalizeHeadingKey(left.heading)) ?? 999) -
        (order.get(normalizeHeadingKey(right.heading)) ?? 999)
    );
}

function buildAutomaticManuscriptVisuals(
  evidence: PrimaryComparisonEvidence | undefined
): {
  tables: PaperManuscriptTable[];
  figures: PaperManuscriptFigure[];
} {
  if (!evidence) {
    return { tables: [], figures: [] };
  }
  return {
    tables: [buildPrimaryComparisonTable(evidence)],
    figures: [buildPrimaryComparisonFigure(evidence)]
  };
}

function buildAutomaticManuscriptAppendix(
  resultAnalysis: ResultAnalysisArtifact | undefined
): {
  sections: PaperManuscriptSection[];
  tables: PaperManuscriptTable[];
} {
  if (!resultAnalysis) {
    return { sections: [], tables: [] };
  }

  const executedTrials = resultAnalysis.statistical_summary?.executed_trials;
  const totalTrials = resultAnalysis.statistical_summary?.total_trials;
  const intervals = (resultAnalysis.statistical_summary?.confidence_intervals || [])
    .filter((interval) => typeof interval.lower === "number" && typeof interval.upper === "number")
    .slice(0, 3);

  const experimentParagraphs: string[] = [];
  if (typeof executedTrials === "number" && typeof totalTrials === "number") {
    experimentParagraphs.push(
      `The executed study completed ${formatTexNumber(executedTrials)} of ${formatTexNumber(totalTrials)} scheduled runs.`
    );
  }
  const uncertaintyParagraphs = intervals.map(
    (interval) => `${humanizeMetricLabel(interval.metric_key)} interval: ${formatInterval(interval)}.`
  );
  const sections: PaperManuscriptSection[] = [
    { heading: "Supplementary Run Accounting", paragraphs: experimentParagraphs },
    { heading: "Supplementary Uncertainty", paragraphs: uncertaintyParagraphs }
  ].filter((section) => section.paragraphs.length > 0);

  const rows = [
    typeof totalTrials === "number" ? { label: "Scheduled runs", value: totalTrials } : undefined,
    typeof executedTrials === "number" ? { label: "Executed runs", value: executedTrials } : undefined
  ].filter((row): row is PaperManuscriptVisualRow => Boolean(row));

  return {
    sections,
    tables: rows.length > 0
      ? [{ caption: "Supplementary run accounting.", rows }]
      : []
  };
}

function formatInterval(interval: { lower: number; upper: number; sample_size?: number }): string {
  const sampleText = typeof interval.sample_size === "number" ? ` over n=${interval.sample_size}` : "";
  return `[${formatTexNumber(interval.lower)}, ${formatTexNumber(interval.upper)}]${sampleText}`;
}

function visualRowsMeetQualityGate(rows: PaperManuscriptVisualRow[]): boolean {
  if (rows.length < 3) {
    return false;
  }
  const readableRows = rows.filter((row) => isHumanReadableMetricLabel(row.label));
  if (readableRows.length < 3) {
    return false;
  }
  const distinctValues = new Set(readableRows.map((row) => row.value.toString()));
  return distinctValues.size >= 2;
}

function isHumanReadableMetricLabel(label: string): boolean {
  const cleaned = cleanString(label);
  if (!cleaned || cleaned.length > 48) {
    return false;
  }
  if (/\.json\b|\.ya?ml\b|\/|\\/iu.test(cleaned)) {
    return false;
  }
  if (cleaned.split(/\s+/).length > 6) {
    return false;
  }
  return /[a-z]/iu.test(cleaned);
}

function humanizeMetricLabel(label: string): string {
  const cleaned = cleanString(label)
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return "";
  }
  return cleaned
    .split(" ")
    .map((token) => {
      if (!token) {
        return token;
      }
      if (token === token.toUpperCase()) {
        return token;
      }
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join(" ");
}

function shouldRenderSubmissionCitationsForParagraph(heading: string, paragraph: string, _paragraphIndex: number): boolean {
  const key = normalizeHeadingKey(heading);
  const sectionSlug = key.replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
  if (sectionSlug === "related_work") {
    return !/\b(?:present study|present contribution|this manuscript|this paper positions|positioned differently|executed run|empirical claim rests)\b/iu.test(paragraph);
  }
  if (key === "method") {
    return false;
  }
  if (key === "discussion" || key === "limitations" || key === "conclusion") {
    return /\b(?:prior work|previous studies|related work|cited work|the literature)\b/iu.test(paragraph);
  }
  if (key !== "introduction") {
    return false;
  }
  return false;
}

function renderSubmissionParagraph(
  paragraph: string,
  citationPaperIds: string[],
  citationKeysByPaperId: Map<string, string>
): string {
  const resolvedKeys = uniqueStrings(
    citationPaperIds
      .map((paperId) => citationKeysByPaperId.get(paperId))
      .filter((key): key is string => Boolean(key))
  ).sort((left, right) => left.localeCompare(right));
  const unresolvedCount = citationPaperIds.length - resolvedKeys.length;
  const citationSuffix = resolvedKeys.length > 0 ? ` \\cite{${resolvedKeys.join(",")}}` : "";
  const unresolvedSuffix = unresolvedCount > 0 ? " [?]" : "";
  return `${latexEscape(paragraph)}${citationSuffix}${unresolvedSuffix}`;
}

function resolveSubmissionBibliographyStyle(input: {
  template?: string;
  parsedTemplate?: ParsedLatexTemplate | null;
}): string | null {
  const templateSurface = [
    input.template || "",
    input.parsedTemplate?.preDocumentPreamble || "",
    input.parsedTemplate?.documentClass || "",
    input.parsedTemplate?.preamble || "",
    ...(input.parsedTemplate?.packages || [])
  ].join("\n");
  const aclTemplate = detectAclTemplatePackage(templateSurface);
  if (aclTemplate) {
    return null;
  }
  const templateStyle = input.parsedTemplate?.bibliographyStyle?.trim();
  if (templateStyle) {
    return templateStyle;
  }
  return "unsrt";
}

function renderSubmissionVisuals(
  manuscript: PaperManuscript,
  figureRenderMode: "latex_bars" | "external_pdf" = "latex_bars"
): string[] {
  return renderVisualCollection(manuscript.tables || [], manuscript.figures || [], figureRenderMode);
}

function renderVisualCollection(
  tables: PaperManuscriptTable[],
  figures: PaperManuscriptFigure[],
  figureRenderMode: "latex_bars" | "external_pdf" = "latex_bars"
): string[] {
  const lines: string[] = [];
  for (const table of tables) {
    lines.push("\\begin{table}[t]");
    lines.push("\\centering");
    lines.push("\\small");
    lines.push("\\begin{tabularx}{\\columnwidth}{>{\\raggedright\\arraybackslash}X r}");
    lines.push("\\toprule");
    lines.push("Metric & Value \\\\");
    lines.push("\\midrule");
    for (const row of table.rows) {
      lines.push(`${latexEscape(row.label)} & ${formatTexNumber(row.value)} \\\\`);
    }
    lines.push("\\bottomrule");
    lines.push("\\end{tabularx}");
    lines.push(`\\caption{${latexEscape(table.caption)}}`);
    lines.push("\\end{table}");
    lines.push("");
  }

  for (let index = 0; index < figures.length; index += 1) {
    const figure = figures[index];
    if (figureRenderMode === "external_pdf") {
      lines.push("\\begin{figure}[t]");
      lines.push("\\centering");
      lines.push(`\\includegraphics[width=\\columnwidth]{figures/main-result-figure-${index + 1}.pdf}`);
      lines.push(`\\caption{${latexEscape(figure.caption)}}`);
      lines.push("\\end{figure}");
      lines.push("");
      continue;
    }
    const maxValue = Math.max(...figure.bars.map((row) => Math.abs(row.value)), 1);
    lines.push("\\begin{figure}[t]");
    lines.push("\\centering");
    lines.push("\\small");
    lines.push("\\begin{tabularx}{\\columnwidth}{>{\\raggedright\\arraybackslash}X l r}");
    for (const row of figure.bars) {
      const widthEm = Math.max(0.4, Math.min(4, Number(((Math.abs(row.value) / maxValue) * 4).toFixed(2))));
      lines.push(`${latexEscape(row.label)} & \\makebox[4.2em][l]{\\rule{${widthEm}em}{1.2ex}} & ${formatTexNumber(row.value)} \\\\`);
    }
    lines.push("\\end{tabularx}");
    lines.push(`\\caption{${latexEscape(figure.caption)}}`);
    lines.push("\\end{figure}");
    lines.push("");
  }

  return lines;
}

function buildSubmissionSupportPackages(parsedTemplate?: ParsedLatexTemplate | null): string[] {
  const preamble = parsedTemplate?.preamble || "";
  const packages = [
    "\\usepackage{graphicx}",
    "\\usepackage{booktabs}",
    "\\usepackage{array}",
    "\\usepackage{tabularx}"
  ];
  const layoutGuards = preamble.includes("\\emergencystretch")
    ? []
    : ["\\emergencystretch=3em"];
  return [
    ...packages.filter((pkg) => {
      const name = pkg.match(/\{([^}]+)\}/u)?.[1];
      return name ? !new RegExp(`\\\\usepackage(?:\\[[^\\]]*\\])?\\{${escapeRegExp(name)}\\}`, "u").test(preamble) : true;
    }),
    ...layoutGuards
  ];
}

function renderAuthorCommand(authorMetadata?: PaperAuthorMetadata | null): string | undefined {
  if (!authorMetadata || authorMetadata.anonymous) {
    return undefined;
  }
  const authors = uniqueStrings(authorMetadata.authors || []);
  if (authors.length === 0) {
    return undefined;
  }
  const affiliations = authorMetadata.affiliations || [];
  const authorText = authors.map((author, index) => {
    const affiliation = affiliations[index];
    return affiliation ? `${latexEscape(author)} \\\\ ${latexEscape(affiliation)}` : latexEscape(author);
  }).join(" \\and ");
  return `\\author{${authorText}}`;
}

function collectClaimIdsForSection(
  claims: PaperDraftClaim[],
  sectionHeading: string | undefined
): string[] {
  if (!sectionHeading) {
    return [];
  }
  return uniqueStrings(
    claims
      .filter((claim) => normalizeHeadingKey(claim.section_heading) === normalizeHeadingKey(sectionHeading))
      .map((claim) => claim.claim_id)
      .filter(Boolean)
  ).slice(0, 6);
}

function validateSubmissionChunk(
  text: string,
  location: string,
  issues: PaperSubmissionValidationIssue[]
): void {
  if (!text) {
    return;
  }
  if (/\[\s*\?(?:\s*,\s*\?)*\s*\]/u.test(text)) {
    issues.push({
      kind: "placeholder_citation",
      location,
      message: "Submission text still contains unresolved citation placeholders.",
      value: extractFirstMatch(text, /\[\s*\?(?:\s*,\s*\?)*\s*\]/u)
    });
  }
  if (/\bev_[a-z0-9_-]+\b/iu.test(text) || /\bev\\_[a-z0-9\\_-]+\b/iu.test(text)) {
    issues.push({
      kind: "evidence_id",
      location,
      message: "Submission text leaked a raw evidence identifier.",
      value:
        extractFirstMatch(text, /\bev_[a-z0-9_-]+\b/iu) ||
        extractFirstMatch(text, /\bev\\_[a-z0-9\\_-]+\b/iu)
    });
  }
  if (/\/(?:Users|home|tmp|var|private|Volumes)\//u.test(text) || /\.autolabos\//u.test(text)) {
    issues.push({
      kind: "absolute_path",
      location,
      message: "Submission text leaked an absolute or internal file path.",
      value:
        extractFirstMatch(text, /\/(?:Users|home|tmp|var|private|Volumes)\/[^\s)]+/u) ||
        extractFirstMatch(text, /\.autolabos\/[^\s)]+/u)
    });
  }
  const artifactPattern = new RegExp(INTERNAL_ARTIFACT_FILENAMES.map(escapeRegExp).join("|"), "iu");
  if (artifactPattern.test(text)) {
    issues.push({
      kind: "artifact_filename",
      location,
      message: "Submission text leaked an internal artifact filename.",
      value: extractFirstMatch(text, artifactPattern)
    });
  }
  const rawMetricPattern = /\b[a-z][a-z0-9]*(?:(?:\\?_)[a-z0-9]+){2,}\b/iu;
  if (location !== "paper.main.tex" && rawMetricPattern.test(text)) {
    issues.push({
      kind: "raw_artifact_text",
      location,
      message: "Submission text leaked a raw artifact metric key.",
      value: extractFirstMatch(text, rawMetricPattern)
    });
  }
  const diagnosticPattern = /^\s*\[(?:warning|error|fail|failed|pass|passed)\]\s*[^:]{0,80}:/imu;
  if (diagnosticPattern.test(text)) {
    issues.push({
      kind: "raw_artifact_text",
      location,
      message: "Submission text leaked an internal diagnostic line.",
      value: extractFirstMatch(text, diagnosticPattern)
    });
  }
  const bannedHeading = BANNED_HEADINGS.find((heading) =>
    location === "paper.main.tex"
      ? new RegExp(`(?:^|\\n)\\\\section\\{${escapeRegExp(heading)}\\}`, "u").test(text)
      : normalizeHeadingKey(text) === normalizeHeadingKey(heading) ||
          new RegExp(`(?:^|\\n)${escapeRegExp(heading)}\\s*:`, "iu").test(text)
  );
  if (bannedHeading) {
    issues.push({
      kind: "banned_heading",
      location,
      message: "Submission text includes a banned debug-style heading.",
      value: bannedHeading
    });
  }
}

function resolveDocumentClass(template: string | undefined): string {
  if (cleanString(template).toLowerCase() === "acl") {
    return "\\documentclass{article}";
  }
  return "\\documentclass{article}";
}

function isBannedHeading(heading: string): boolean {
  return BANNED_HEADINGS.some(
    (item) => normalizeHeadingKey(item) === normalizeHeadingKey(heading)
  );
}

function buildTraceabilityKey(sectionHeading: string, paragraphIndex: number): string {
  return `${normalizeHeadingKey(sectionHeading)}:${paragraphIndex}`;
}

function buildAggregateDraftGrounding(draft: PaperDraft): {
  evidenceIds: string[];
  citationPaperIds: string[];
  claimIds: string[];
  sourceRefs?: PaperSourceRef[];
} {
  const evidenceIds = uniqueStrings(
    draft.sections.flatMap((section) => [
      ...(section.evidence_ids || []),
      ...section.paragraphs.flatMap((paragraph) => paragraph.evidence_ids || [])
    ])
  );
  const citationPaperIds = uniqueStrings(
    draft.sections.flatMap((section) => [
      ...(section.citation_paper_ids || []),
      ...section.paragraphs.flatMap((paragraph) => paragraph.citation_paper_ids || [])
    ])
  );
  const claimIds = uniqueStrings(draft.claims.map((claim) => claim.claim_id));
  return {
    evidenceIds,
    citationPaperIds,
    claimIds,
    sourceRefs: buildParagraphSourceRefs({
      evidenceIds,
      citationPaperIds,
      claimIds
    })
  };
}

function buildTraceabilityEntriesForSectionCollection(input: {
  sections: PaperManuscriptSection[];
  draft: PaperDraft;
  sectionByHeading: Map<string, PaperDraft["sections"][number]>;
  anchorNamespace: "main" | "appendix";
}): PaperTraceabilityEntry[] {
  return input.sections.flatMap((section, sectionIndex) => {
    const sourceSection =
      input.sectionByHeading.get(normalizeHeadingKey(section.heading)) ||
      input.draft.sections[Math.min(sectionIndex, Math.max(0, input.draft.sections.length - 1))];
    const claimIds = collectClaimIdsForSection(input.draft.claims, sourceSection?.heading);

    return section.paragraphs.map((_, paragraphIndex) => {
      const sourceParagraph =
        sourceSection?.paragraphs[Math.min(paragraphIndex, Math.max(0, (sourceSection?.paragraphs.length || 1) - 1))];
      const evidenceIds = uniqueStrings(
        sourceParagraph?.evidence_ids?.length ? sourceParagraph.evidence_ids : sourceSection?.evidence_ids || []
      );
      const citationPaperIds = uniqueStrings(
        sourceParagraph?.citation_paper_ids?.length
          ? sourceParagraph.citation_paper_ids
          : sourceSection?.citation_paper_ids || []
      );
      const sourceRefs = buildParagraphSourceRefs({
        evidenceIds,
        citationPaperIds,
        claimIds
      });
      const anchorHeading =
        input.anchorNamespace === "appendix"
          ? `Appendix ${section.heading}`
          : section.heading;
      return {
        anchor_id: buildParagraphAnchorId(anchorHeading, paragraphIndex),
        manuscript_section: section.heading,
        paragraph_index: paragraphIndex,
        source_draft_section: sourceSection?.heading || "",
        evidence_ids: evidenceIds,
        citation_paper_ids: citationPaperIds,
        ...(sourceRefs ? { source_refs: sourceRefs } : {}),
        ...(claimIds.length > 0 ? { claim_ids: claimIds } : {})
      };
    });
  });
}

function takeSafeStrings(values: string[], limit: number): string[] {
  return uniqueStrings(values.map((item) => cleanString(item)).filter(isSafeSubmissionText)).slice(0, limit);
}

function buildParagraphSourceRefs(input: {
  evidenceIds: string[];
  citationPaperIds: string[];
  claimIds: string[];
}): PaperSourceRef[] | undefined {
  const refs = [
    ...input.evidenceIds.map((id) => ({ kind: "evidence" as const, id })),
    ...input.claimIds.map((id) => ({ kind: "claim" as const, id })),
    ...input.citationPaperIds.map((id) => ({ kind: "citation" as const, id }))
  ];
  return refs.length > 0 ? refs : undefined;
}

function isSafeSubmissionText(text: string): boolean {
  if (!text) {
    return false;
  }
  if (/\bev_[a-z0-9_-]+\b/iu.test(text)) {
    return false;
  }
  if (/\/(?:Users|home|tmp|var|private|Volumes)\//u.test(text) || /\.autolabos\//u.test(text)) {
    return false;
  }
  return !new RegExp(INTERNAL_ARTIFACT_FILENAMES.map(escapeRegExp).join("|"), "iu").test(text);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(value.map((item) => cleanString(item)).filter(Boolean));
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number(value.toFixed(4));
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Number(parsed.toFixed(4));
    }
  }
  return undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => cleanString(value)).filter(Boolean))];
}

function normalizeHeadingKey(value: string): string {
  return cleanString(value).toLowerCase();
}

function buildParagraphAnchorId(sectionHeading: string, paragraphIndex: number): string {
  const heading = normalizeHeadingKey(sectionHeading).replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
  return `paragraph:${heading || "section"}:${paragraphIndex}`;
}

function lowercaseLeadingWord(value: string): string {
  const cleaned = cleanString(value);
  if (!cleaned) {
    return cleaned;
  }
  return cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
}

function latexEscape(value: string): string {
  return value
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([#$%&_{}])/g, "\\$1")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/~/g, "\\textasciitilde{}");
}

function formatTexNumber(value: number): string {
  return Number(value.toFixed(4)).toString();
}

function extractFirstJsonObject(text: string): string {
  const start = text.indexOf("{");
  if (start < 0) {
    throw new Error("paper_manuscript_json_not_found");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  throw new Error("paper_manuscript_json_not_closed");
}

function extractFirstMatch(text: string, pattern: RegExp): string | undefined {
  const match = text.match(pattern);
  return match?.[0];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
