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
  condition_parameter_x?: number;
  condition_parameter_y?: number;
  condition_axis_x_label?: string;
  condition_axis_y_label?: string;
  average_accuracy?: number;
  accuracy_delta_vs_baseline?: number;
  accuracy_delta_vs_comparator?: number;
  benchmark_task_a_accuracy?: number;
  benchmark_task_b_accuracy?: number;
  benchmark_task_a_label?: string;
  benchmark_task_b_label?: string;
  train_loss?: number;
  runtime_seconds?: number;
  peak_memory_mb?: number;
  is_baseline?: boolean;
  is_comparator?: boolean;
  is_registered_baseline?: boolean;
}

export interface PaperManuscriptTable {
  caption: string;
  rows: PaperManuscriptVisualRow[];
  source_refs?: PaperSourceRef[];
  condition_axis_x_label?: string;
  condition_axis_y_label?: string;
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

export interface PaperManuscriptConditionSummary {
  label?: string;
  condition?: string;
  is_baseline?: boolean;
  is_comparator?: boolean;
  is_registered_baseline?: boolean;
  condition_parameter_x?: number;
  condition_parameter_y?: number;
  condition_axis_x_label?: string;
  condition_axis_y_label?: string;
  average_accuracy_mean?: number;
  accuracy_delta_vs_baseline_mean?: number;
  benchmark_task_a_accuracy?: number;
  benchmark_task_b_accuracy?: number;
  benchmark_task_a_label?: string;
  benchmark_task_b_label?: string;
}

export interface PaperManuscriptStabilizationOptions {
  conditionSummaries?: PaperManuscriptConditionSummary[];
  resultAnalysis?: ResultAnalysisArtifact;
  methodModelNames?: string[];
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
}): string {
  const highlights = curatePaperResultHighlights({
    resultAnalysis: input.bundle.resultAnalysis,
    objectiveEvaluation: input.objectiveEvaluation,
    objectiveMetricProfile: input.objectiveMetricProfile,
    experimentPlan: input.bundle.experimentPlan
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
  fallbackManuscript?: PaperManuscript;
}): PaperManuscript {
  const fallback = buildFallbackPaperManuscript({
    draft: input.draft,
    resultAnalysis: input.resultAnalysis,
    objectiveEvaluation: input.objectiveEvaluation,
    objectiveMetricProfile: input.objectiveMetricProfile,
    experimentPlan: input.experimentPlan
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
  const resolvedSections = repairReaderVisibleManuscriptCoherence(enrichManuscriptMethodExecutionDetails({
    sections: resolvedBaseSections || baseManuscript.sections,
    resultAnalysis: input.resultAnalysis
  }));
  const resolvedTables = preserveVisualSourceRefs(
    tables.length > 0 ? tables : baseManuscript.tables,
    baseManuscript.tables
  );
  const resolvedFigures = removeRedundantTaskDeltaFigures(preserveVisualSourceRefs(
    figures.length > 0 ? figures : baseManuscript.figures,
    baseManuscript.figures
  ));
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
    conditionSummaries: conditionSummariesFromResultAnalysis(input.resultAnalysis),
    resultAnalysis: input.resultAnalysis
  });
}

export function stabilizePaperManuscriptForSubmission(
  manuscript: PaperManuscript,
  options: PaperManuscriptStabilizationOptions = {}
): PaperManuscript {
  const conditionSummaries = resolveConditionSummariesForSubmission(options);
  const baselineComparatorMismatch = hasBaselineComparatorMismatch(conditionSummaries);
  const sectionsWithMethodDetails = options.resultAnalysis
    ? enrichManuscriptMethodExecutionDetails({
        sections: manuscript.sections,
        resultAnalysis: options.resultAnalysis,
        methodModelNames: options.methodModelNames
      })
    : options.methodModelNames?.length
      ? enrichManuscriptMethodExecutionDetails({
          sections: manuscript.sections,
          methodModelNames: options.methodModelNames
        })
    : manuscript.sections;
  const sections = repairBaselineComparatorMismatchClaims(
    removeReaderVisibleRawProtocolResidue(
      repairReaderVisibleManuscriptCoherence(sectionsWithMethodDetails)
    ),
    baselineComparatorMismatch
  );
  const conditionAxisLabels = resolveConditionAxisLabelsForSubmission(manuscript, options, conditionSummaries);
  const benchmarkTaskLabels = resolveBenchmarkTaskLabels(conditionSummaries, manuscript, options);
  const tables = ensureMainBodyResultTable({
    tables: manuscript.tables,
    conditionSummaries,
    conditionAxisLabels,
    baselineComparatorMismatch
  });
  const shouldPreserveExistingDerivedFigures = tables?.some(isReliableDerivedMainTable) === true;
  const figures = ensureMainBodyResultFigure({
    tables,
    figures: shouldPreserveExistingDerivedFigures ? manuscript.figures : removeRedundantTaskDeltaFigures(manuscript.figures),
    conditionSummaries,
    conditionAxisLabels,
    benchmarkTaskLabels,
    baselineComparatorMismatch
  });
  return {
    ...manuscript,
    title: repairSubmissionTitle(manuscript.title),
    abstract: repairBaselineComparatorMismatchText(
      repairSubmissionAbstract(manuscript.abstract),
      baselineComparatorMismatch
    ),
    keywords: repairPaperKeywords(manuscript.keywords),
    sections,
    ...(tables ? { tables: repairMainTableClaims(tables) } : {}),
    ...(figures?.length ? { figures } : {}),
    ...(manuscript.appendix_sections ? { appendix_sections: repairAppendixSections(manuscript.appendix_sections) } : {}),
    ...(manuscript.appendix_tables ? { appendix_tables: repairAppendixTableLabels(manuscript.appendix_tables) } : {})
  };
}

function hasBaselineComparatorMismatch(conditionSummaries: PaperManuscriptConditionSummary[]): boolean {
  const registeredBaseline = conditionSummaries.find(
    (condition) => condition.is_registered_baseline === true || (condition.is_baseline === true && condition.is_comparator !== true)
  );
  const comparator = conditionSummaries.find((condition) => condition.is_comparator === true);
  if (!registeredBaseline || !comparator || registeredBaseline === comparator) {
    return false;
  }
  if (conditionsReferToSameCell(registeredBaseline, comparator)) {
    return false;
  }
  return true;
}

function conditionsReferToSameCell(
  left: PaperManuscriptConditionSummary,
  right: PaperManuscriptConditionSummary
): boolean {
  const leftCondition = cleanString(left.condition || left.label);
  const rightCondition = cleanString(right.condition || right.label);
  if (leftCondition && rightCondition && leftCondition === rightCondition) {
    return true;
  }
  const hasLeftParameters = typeof left.condition_parameter_x === "number" || typeof left.condition_parameter_y === "number";
  const hasRightParameters = typeof right.condition_parameter_x === "number" || typeof right.condition_parameter_y === "number";
  if (!hasLeftParameters || !hasRightParameters) {
    return false;
  }
  const xMatches =
    typeof left.condition_parameter_x !== "number"
    || typeof right.condition_parameter_x !== "number"
    || areNumbersClose(left.condition_parameter_x, right.condition_parameter_x);
  const yMatches =
    typeof left.condition_parameter_y !== "number"
    || typeof right.condition_parameter_y !== "number"
    || areNumbersClose(left.condition_parameter_y, right.condition_parameter_y);
  return xMatches && yMatches;
}

function repairBaselineComparatorMismatchClaims(
  sections: PaperManuscriptSection[],
  baselineComparatorMismatch: boolean
): PaperManuscriptSection[] {
  if (!baselineComparatorMismatch) {
    return sections;
  }
  return sections.map((section) => ({
    ...section,
    paragraphs: section.paragraphs
      .map((paragraph) => repairBaselineComparatorMismatchText(paragraph, true))
      .filter(Boolean)
  }));
}

function repairBaselineComparatorMismatchText(text: string, baselineComparatorMismatch: boolean): string {
  const cleaned = cleanString(text);
  if (!baselineComparatorMismatch || !cleaned) {
    return cleaned;
  }
  return cleanString(cleaned
    .replace(/\bregistered\s+registered-baseline\b/giu, "registered-baseline")
    .replace(
      /\bBecause the registered baseline and archived delta reference are not fully reconciled in the available artifacts,\s*the stronger claim that the registered-baseline objective remains unresolved is deferred\.?/giu,
      "Because the registered baseline and archived delta reference are different reported rows, the displayed-reference difference is retained only as a screening contrast and no registered-baseline success claim is accepted."
    )
    .replace(
      /\bBecause the registered baseline and archived comparator roles remain unreconciled in the available artifacts,\s*the stronger claim that the registered-baseline objective remains unresolved is deferred\.?/giu,
      "Because the registered baseline and archived comparator are different reported rows, the displayed-reference difference is retained only as a screening contrast and no registered-baseline success claim is accepted."
    )
    .replace(
      /\bThe aggregate result table reports a positive value for the primary accuracy objective\.?/giu,
      "The aggregate result table reports a positive difference relative to the reported delta-reference row, but the registered-baseline objective is not accepted as met because the delta reference differs from the registered baseline."
    )
    .replace(
      /\bThis fixed-budget ([^.]+?) reports a positive aggregate accuracy result\b/giu,
      "This fixed-budget $1 reports a positive delta-reference accuracy difference"
    )
    .replace(
      /\bThe baseline row has mean accuracy ([0-9]+(?:\.[0-9]+)?),\s*while the best reported comparator row has mean accuracy ([0-9]+(?:\.[0-9]+)?)\.?/giu,
      "The reported delta-reference row has mean accuracy $1, while the best reported condition has mean accuracy $2."
    )
    .replace(
      /\bThe absolute difference is ([0-9]+(?:\.[0-9]+)?),\s*or about ([0-9]+(?:\.[0-9]+)?) percentage points\.?/giu,
      "The delta-reference difference is $1, or about $2 percentage points."
    )
    .replace(
      /\bThis exceeds the predefined numerical threshold of \+?([0-9]+(?:\.[0-9]+)?)\.?/giu,
      "This is positive relative to the reported delta-reference row, but it does not establish that the registered-baseline threshold of +$1 was met."
    )
    .replace(
      /\bthe gain is practically meaningful under the stated threshold,\s*but it is still a small-count effect in a screening-scale evaluation\.?/giu,
      "the displayed-reference contrast clears the screening yardstick, but no registered-baseline success claim is accepted and the effect remains small-count evidence."
    )
    .replace(
      /\bThe available records support the statement that the numerical target was met\b/giu,
      "The available records support only the reported delta-reference difference, not a settled registered-baseline target claim"
    )
    .replace(
      /\bThe observed gain clears the predefined \+?1\.0 percentage[-\s]?point threshold\b/giu,
      "The observed delta-reference difference is positive, but the predefined registered-baseline threshold remains unresolved"
    )
    .replace(
      /\bThe observed gain clears the predefined \+?0\.01 threshold\b/giu,
      "The observed delta-reference difference is positive, but the predefined registered-baseline threshold remains unresolved"
    )
    .replace(
      /\bThe aggregate result summary reports that the primary point-estimate objective was met\.?/giu,
      "The aggregate result summary is relative to the reported delta-reference row, while the registered baseline differs; the primary baseline-relative objective is therefore not accepted as met."
    )
    .replace(
      /\bThis exceeds the predefined \+?0\.01 practical-improvement threshold\.\s*Interpreted narrowly, the run therefore provides a positive screening signal\.*/giu,
      "This numeric difference is retained as a delta-reference screening signal, not as evidence that the registered-baseline objective was met."
    )
    .replace(
      /\bAll threshold-based claims are intended to be evaluated against this baseline\.?/giu,
      "Because the reported delta-reference row differs from this registered baseline, threshold-based claims are treated as unresolved rather than accepted."
    )
    .replace(
      /\bThe primary metric was the absolute change in the mean of the two task accuracies relative to the baseline condition\.?/giu,
      "The intended primary metric was the absolute change in the mean of the two task accuracies relative to the registered baseline condition, but the archived delta field uses a different reported delta-reference row."
    )
    .replace(
      /\bThe summarized aggregate comparison reports a \+?([0-9]+(?:\.[0-9]+)?) improvement in mean ([^.]+), exceeding the predefined \+?0\.01 threshold\.?/giu,
      "The summarized aggregate comparison reports a +$1 delta-reference difference in mean $2; because the comparator differs from the registered baseline, this does not establish that the predefined threshold was met."
    )
    .replace(
      /\bbaseline-relative average-accuracy gain\s*(?:=|is|was|of|reported as)?\s*\+?([0-9]+(?:\.[0-9]+)?)\b/giu,
      "displayed-reference average-accuracy difference $1"
    )
    .replace(
      /\bbaseline-relative accuracy gain\s*(?:=|is|was|of|reported as)?\s*\+?([0-9]+(?:\.[0-9]+)?)\b/giu,
      "displayed-reference accuracy difference $1"
    )
    .replace(
      /\bThe primary objective metric was baseline-relative average accuracy across ([^.]+?)\.\s*The aggregate result table reports an observed gain of ([0-9]+(?:\.[0-9]+)?) against a target of ([0-9]+(?:\.[0-9]+)?)\.\s*In percentage-point terms, this is approximately \+?([0-9]+(?:\.[0-9]+)?) points, exceeding the pre-specified \+?([0-9]+(?:\.[0-9]+)?) point threshold\.?/giu,
      "The intended primary metric was average accuracy across $1 relative to the registered baseline. The available aggregate row instead reports a $2 displayed-reference difference; this is a screening contrast, not evidence that the registered-baseline target of $3 was met."
    )
    .replace(
      /\bThe aggregate result table reports an observed gain of ([0-9]+(?:\.[0-9]+)?) against a target of ([0-9]+(?:\.[0-9]+)?)\.\s*In percentage-point terms, this is approximately \+?([0-9]+(?:\.[0-9]+)?) points, exceeding the pre-specified \+?([0-9]+(?:\.[0-9]+)?) point threshold\.?/giu,
      "The aggregate result table reports a $1 displayed-reference difference against a $2 screening yardstick; this does not accept the registered-baseline target as met."
    )
    .replace(
      /\b(?:the )?prespecified baseline-relative (?:accuracy )?target was met\b/giu,
      "the delta-reference difference is positive, but no registered-baseline success claim is accepted"
    )
    .replace(
      /\bprimary (?:point-estimate )?objective was met\b/giu,
      "registered-baseline success claim is not accepted"
    )
    .replace(
      /\bbaseline-relative objective (?:was|is) met\b/giu,
      "registered-baseline success claim is not accepted"
    )
    .replace(
      /\bexceed(?:s|ed|ing) the predefined \+?0\.01 threshold\b/giu,
      "positive against the reported delta-reference row but not accepted as a registered-baseline success"
    )
  );
}

function repairPaperKeywords(keywords: string[]): string[] {
  return keywords
    .map((keyword) =>
      cleanString(keyword)
        .replace(/\baccuracy_delta_vs_baseline\b/giu, "baseline-relative accuracy gain")
        .replace(/\baverage_accuracy\b/giu, "average accuracy")
        .replace(/\bbenchmark_task_a_accuracy\b/giu, "Benchmark Task A accuracy")
        .replace(/\bbenchmark_task_b_accuracy\b/giu, "Benchmark Task B accuracy")
    )
    .filter(Boolean)
    .slice(0, 6);
}

function repairReaderVisibleMetricNames(text: string): string {
  return cleanString(text)
    .replace(
      /\bThe reported study uses\s+(?:Primary trained baseline|Unmodified-system comparator|Comparator set for Pareto analysis):[\s\S]{0,600}?\bas the trained backbone\.\s*/giu,
      ""
    )
    .replace(
      /\bThe executed run used\s+(?:Primary trained baseline|Unmodified-system comparator|Comparator set for Pareto analysis):[\s\S]{0,600}?(?:\.|$)\s*/giu,
      ""
    )
    .replace(/\bparameter-computationally\s+practical\s+within\s+the\s+reported\s+setup\b/giu, "parameter-efficient")
    .replace(/\bmemory-computationally\s+practical\s+within\s+the\s+reported\s+setup\b/giu, "memory-efficient")
    .replace(/\bcost-computationally\s+practical\s+within\s+the\s+reported\s+setup\b/giu, "cost-efficient")
    .replace(/\bcompute-computationally\s+practical\s+within\s+the\s+reported\s+setup\b/giu, "compute-efficient")
    .replace(/\binspect-relevant\b/giu, "protocol-relevant")
    .replace(/\bFor\s+inspect\s+purposes\b/giu, "For clarity")
    .replace(/\baccuracy\\?_delta\\?_vs\\?_baseline\b/giu, "baseline-relative accuracy gain")
    .replace(/\baverage\\?_accuracy\b/giu, "average accuracy")
    .replace(/\bbenchmark_task_a\\?_accuracy\b/giu, "Benchmark Task A accuracy")
    .replace(/\bbenchmark_task_b\\?_accuracy\b/giu, "Benchmark Task B accuracy");
}

function repairMainTableClaims(
  tables: PaperManuscriptTable[] | undefined
): PaperManuscriptTable[] | undefined {
  if (!tables) {
    return tables;
  }
  return tables.map((table) => {
    const rowText = table.rows.map((row) => row.label).join(" ");
    const exposesAllCells = table.rows.length >= 4 && /\b(?:baseline|condition|candidate)\b/iu.test(rowText);
    const caption = exposesAllCells
      ? cleanString(table.caption)
      : cleanString(table.caption)
          .replace(
            /\bExecuted sweep summary and key comparison quantities visible in the condensed record\.?/giu,
            "Baseline and leading-condition comparison quantities visible in the condensed record."
          )
          .replace(
            /\bMean accuracy is shown for all condition-parameter cells;?\s*/giu,
            ""
          )
          .replace(
            /\badditional rows report the task-level accuracies,\s*interval bounds,\s*training-loss comparison,\s*and execution totals discussed in the main text where those values are explicitly available\.?/giu,
            "Rows report task-level accuracies, interval bounds, and training-loss values where those quantities are explicitly available."
          )
          .replace(
            /\bexecuted grid\b/giu,
            "baseline-to-leading comparison"
          )
          .replace(
            /\bexecution totals\b/giu,
            "run-level execution notes"
          );
    return {
      ...table,
      caption: cleanString(caption),
      rows: table.rows
    };
  });
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

function ensureMainBodyResultFigure(input: {
  tables?: PaperManuscriptTable[];
  figures?: PaperManuscriptFigure[];
  conditionSummaries?: PaperManuscriptConditionSummary[];
  conditionAxisLabels?: ConditionAxisLabels;
  benchmarkTaskLabels?: BenchmarkTaskLabels;
  baselineComparatorMismatch?: boolean;
}): PaperManuscriptFigure[] | undefined {
  const baselineComparatorMismatch = input.baselineComparatorMismatch === true || tablesExposeBaselineComparatorMismatch(input.tables);
  const hasReliableDerivedTable = input.tables?.some(isReliableDerivedMainTable) === true;
  const existingDerivedFigure = input.figures?.find((figure) => hasArtifactSourceRef(figure, DERIVED_MAIN_FIGURE_SOURCE_REF_ID));
  const existingDerivedFigureLabels = existingDerivedFigure?.bars.map((bar) => cleanString(bar.label)).join(" ") || "";
  if (
    !baselineComparatorMismatch
    &&
    hasReliableDerivedTable
    && existingDerivedFigure
    && !/\bTask A delta\b|\bTask B delta\b/iu.test(existingDerivedFigureLabels)
    && figureUsesBenchmarkTaskLabels(existingDerivedFigure, input.benchmarkTaskLabels)
  ) {
    return input.figures;
  }
  const figureConditionSummaries = mergeConditionRolesFromTables(input.conditionSummaries || [], input.tables);
  const conditionFigure = buildConditionMeanAccuracyFigure(
    figureConditionSummaries,
    input.conditionAxisLabels,
    baselineComparatorMismatch
  );
  const taskFigure = baselineComparatorMismatch
    ? undefined
    : buildTaskLevelLeadingConditionFigure(figureConditionSummaries, input.conditionAxisLabels, input.benchmarkTaskLabels);
  if (taskFigure) {
    return [taskFigure];
  }
  if (conditionFigure) {
    return [conditionFigure];
  }
  if (baselineComparatorMismatch) {
    return undefined;
  }
  if (input.figures?.length) {
    const retainedFigures = dedupeManuscriptFigures(input.figures.filter((figure) => !isNoisyMixedMetricFigure(figure)));
    return retainedFigures.length > 0 ? retainedFigures : undefined;
  }
  const sourceTable = input.tables?.find((table) => table.rows.length >= 3);
  if (!sourceTable) {
    return undefined;
  }
  const baselineRow =
    sourceTable.rows.find((row) => /\bbaseline\b/iu.test(row.label)) ||
    sourceTable.rows[0];
  if (!baselineRow || typeof baselineRow.value !== "number") {
    return undefined;
  }

  const rows = sourceTable.rows
    .map((row) => {
      const isBaseline = row === baselineRow || /\bbaseline\b/iu.test(row.label);
      const label = cleanString(row.label)
        .replace(/\s*\/\s*/gu, " ")
        .replace(/\s*\((?:locked\s+)?baseline\)\s*/giu, " baseline ")
        .replace(/\s+/gu, " ")
        .trim();
      return {
        label: isBaseline && !/\bbaseline\b/iu.test(label) ? `${label} baseline` : label,
        value: Number((row.value - baselineRow.value).toFixed(6))
      };
    })
    .filter((row) => row.label && isHumanReadableMetricLabel(row.label))
    .slice(0, 8);
  if (rows.filter((row) => Math.abs(row.value) >= 0.0005).length <= 1) {
    return undefined;
  }
  if (!visualRowsMeetQualityGate(rows)) {
    return undefined;
  }
  return [
    {
      caption: "Baseline-relative mean accuracy gain by evaluated condition-parameter condition.",
      bars: rows,
      source_refs: [
        { kind: "artifact", id: DERIVED_MAIN_FIGURE_SOURCE_REF_ID },
        ...(sourceTable.source_refs || [])
      ]
    }
  ];
}

function tablesExposeBaselineComparatorMismatch(tables: PaperManuscriptTable[] | undefined): boolean {
  return Boolean(tables?.some((table) => {
    const caption = cleanString(table.caption);
    const labels = table.rows.map((row) => cleanString(row.label)).join(" ");
    return (
      /\bregistered baseline and delta-reference row are kept separate\b/iu.test(caption)
      || /\barchived reference row and registered baseline are different\b/iu.test(caption)
      || /\bnot\s+delta\s+reference\b/iu.test(labels)
    );
  }));
}

function ensureMainBodyResultTable(input: {
  tables?: PaperManuscriptTable[];
  conditionSummaries?: PaperManuscriptConditionSummary[];
  conditionAxisLabels?: ConditionAxisLabels;
  baselineComparatorMismatch?: boolean;
}): PaperManuscriptTable[] | undefined {
  const derived = buildConditionMeanAccuracyTable(
    input.conditionSummaries,
    input.conditionAxisLabels,
    input.baselineComparatorMismatch === true
  );
  if (input.tables?.some((table) => isReliableDerivedMainTable(table) && derivedTableUsesAxisLabels(table, input.conditionAxisLabels))) {
    return input.tables;
  }
  if (!derived) {
    return input.tables;
  }
  if (input.tables?.some((table) => hasArtifactSourceRef(table, DERIVED_MAIN_TABLE_SOURCE_REF_ID))) {
    return [derived];
  }
  if (!input.tables?.length || input.tables.some(isNoisyMixedMetricTable)) {
    return [derived];
  }
  if (input.tables.some((table) => isIncompleteConditionResultTable(table, derived))) {
    return [derived];
  }
  return input.tables;
}

function mergeConditionRolesFromTables(
  conditionSummaries: PaperManuscriptConditionSummary[],
  tables: PaperManuscriptTable[] | undefined
): PaperManuscriptConditionSummary[] {
  const sourceTable = tables?.find(isReliableDerivedMainTable);
  if (!sourceTable) {
    return conditionSummaries;
  }
  return conditionSummaries.map((condition) => {
    const matchedRow = sourceTable.rows.find((row) => conditionMatchesVisualRow(condition, row));
    if (!matchedRow) {
      return condition;
    }
    return {
      ...condition,
      is_baseline: condition.is_baseline || matchedRow.is_baseline,
      is_comparator: condition.is_comparator || matchedRow.is_comparator,
      is_registered_baseline: condition.is_registered_baseline || matchedRow.is_registered_baseline,
      condition_axis_x_label: condition.condition_axis_x_label || matchedRow.condition_axis_x_label,
      condition_axis_y_label: condition.condition_axis_y_label || matchedRow.condition_axis_y_label,
      benchmark_task_a_label: condition.benchmark_task_a_label || matchedRow.benchmark_task_a_label,
      benchmark_task_b_label: condition.benchmark_task_b_label || matchedRow.benchmark_task_b_label
    };
  });
}

function conditionMatchesVisualRow(
  condition: PaperManuscriptConditionSummary,
  row: PaperManuscriptVisualRow
): boolean {
  const xMatches = typeof condition.condition_parameter_x !== "number"
    || typeof row.condition_parameter_x !== "number"
    || areNumbersClose(condition.condition_parameter_x, row.condition_parameter_x);
  const yMatches = typeof condition.condition_parameter_y !== "number"
    || typeof row.condition_parameter_y !== "number"
    || areNumbersClose(condition.condition_parameter_y, row.condition_parameter_y);
  return xMatches && yMatches && (typeof condition.condition_parameter_x === "number" || typeof condition.condition_parameter_y === "number");
}

function hasArtifactSourceRef(
  item: PaperManuscriptTable | PaperManuscriptFigure,
  sourceRefId: string
): boolean {
  return Boolean(item.source_refs?.some((ref) => ref.kind === "artifact" && ref.id === sourceRefId));
}

function isReliableDerivedMainTable(table: PaperManuscriptTable): boolean {
  if (!hasArtifactSourceRef(table, DERIVED_MAIN_TABLE_SOURCE_REF_ID)) {
    return false;
  }
  const comparator = table.rows.find((row) => row.is_comparator === true);
  const registeredBaseline = table.rows.find(
    (row) => row.is_registered_baseline === true || (row.is_baseline === true && row.is_comparator !== true)
  );
  if (!comparator || !registeredBaseline) {
    return false;
  }
  const labels = `${comparator.label || ""} ${registeredBaseline.label || ""}`;
  return /\b(?:reported|archived|reference|comparison|delta[-\s]reference)\b/iu.test(labels) && /\bregistered baseline\b/iu.test(labels);
}

function isIncompleteConditionResultTable(table: PaperManuscriptTable, derived: PaperManuscriptTable): boolean {
  const text = [table.caption, ...table.rows.map((row) => row.label)].map(cleanString).join(" ");
  const looksConditionLevel = /\bcondition\b/iu.test(text) && /\b(?:accuracy|score|delta|baseline|parameter|factor|metric)\b/iu.test(text);
  if (!looksConditionLevel) {
    return false;
  }
  const derivedStructured = derived.rows.some(
    (row) => typeof row.condition_parameter_x === "number" || typeof row.condition_parameter_y === "number"
  );
  const tableStructured = table.rows.some(
    (row) => typeof row.condition_parameter_x === "number" || typeof row.condition_parameter_y === "number"
  );
  return table.rows.length < derived.rows.length || (derivedStructured && !tableStructured);
}

function buildConditionMeanAccuracyTable(
  conditionSummaries: PaperManuscriptConditionSummary[] | undefined,
  preferredAxisLabels?: ConditionAxisLabels,
  baselineComparatorMismatch = false
): PaperManuscriptTable | undefined {
  const usable = (conditionSummaries || []).filter((condition) => typeof condition.average_accuracy_mean === "number");
  if (usable.length < 2) {
    return undefined;
  }
  const axisLabels = preferredAxisLabels || inferConditionAxisLabels(usable);
  const displayConditions = selectReaderFacingConditionSummaries(usable);
  const rows = displayConditions.map((condition, index) => {
    const label = buildConditionSummaryDisplayLabel(condition, index, axisLabels, baselineComparatorMismatch);
    return {
      label,
      value: Number((condition.average_accuracy_mean as number).toFixed(6)),
      ...(typeof condition.condition_parameter_x === "number"
        ? { condition_parameter_x: condition.condition_parameter_x }
        : {}),
      ...(typeof condition.condition_parameter_y === "number"
        ? { condition_parameter_y: condition.condition_parameter_y }
        : {}),
      condition_axis_x_label: axisLabels.x,
      condition_axis_y_label: axisLabels.y,
      average_accuracy: condition.average_accuracy_mean,
      ...(typeof condition.accuracy_delta_vs_baseline_mean === "number"
        ? { accuracy_delta_vs_comparator: condition.accuracy_delta_vs_baseline_mean }
        : {}),
      ...(typeof condition.benchmark_task_a_accuracy === "number"
        ? { benchmark_task_a_accuracy: condition.benchmark_task_a_accuracy }
        : {}),
      ...(typeof condition.benchmark_task_b_accuracy === "number"
        ? { benchmark_task_b_accuracy: condition.benchmark_task_b_accuracy }
        : {}),
      ...(condition.benchmark_task_a_label ? { benchmark_task_a_label: condition.benchmark_task_a_label } : {}),
      ...(condition.benchmark_task_b_label ? { benchmark_task_b_label: condition.benchmark_task_b_label } : {}),
      ...(condition.is_registered_baseline || (condition.is_baseline && !condition.is_comparator)
        ? { is_baseline: true, is_registered_baseline: true }
        : {}),
      ...(condition.is_comparator ? { is_comparator: true } : {})
    };
  });
  return {
    caption:
      baselineComparatorMismatch
        ? "Condition-level mean accuracy highlights from the executed comparison grid. The archived reference row and registered baseline are different conditions, so the displayed-reference contrast is not accepted as a registered-baseline threshold success."
        : "Condition-level mean accuracy highlights from the executed comparison grid. Reference and registered-baseline rows are shown separately when they differ.",
    rows,
    condition_axis_x_label: axisLabels.x,
    condition_axis_y_label: axisLabels.y,
    source_refs: [{ kind: "artifact", id: DERIVED_MAIN_TABLE_SOURCE_REF_ID }]
  };
}

function selectReaderFacingConditionSummaries(
  conditions: PaperManuscriptConditionSummary[]
): PaperManuscriptConditionSummary[] {
  if (conditions.length <= 8) {
    return conditions;
  }
  const ranked = [...conditions].sort((left, right) =>
    (right.average_accuracy_mean ?? Number.NEGATIVE_INFINITY) - (left.average_accuracy_mean ?? Number.NEGATIVE_INFINITY)
  );
  const leadingValue = ranked[0]?.average_accuracy_mean;
  const trailingValue = ranked[ranked.length - 1]?.average_accuracy_mean;
  const selected: PaperManuscriptConditionSummary[] = [];
  const add = (condition: PaperManuscriptConditionSummary | undefined): void => {
    if (!condition) {
      return;
    }
    if (selected.some((existing) => conditionSummariesReferToSameCell(existing, condition))) {
      return;
    }
    selected.push(condition);
  };
  add(conditions.find((condition) => condition.is_comparator === true));
  add(conditions.find((condition) => condition.is_registered_baseline === true || (condition.is_baseline === true && condition.is_comparator !== true)));
  for (const condition of conditions) {
    if (typeof leadingValue === "number" && areNumbersClose(condition.average_accuracy_mean, leadingValue)) {
      add(condition);
    }
    if (selected.length >= 6) {
      break;
    }
  }
  if (typeof trailingValue === "number" && !areNumbersClose(trailingValue, leadingValue ?? Number.NaN)) {
    add(conditions.find((condition) => areNumbersClose(condition.average_accuracy_mean, trailingValue)));
  }
  for (const condition of conditions) {
    if (selected.length >= 8) {
      break;
    }
    const value = condition.average_accuracy_mean;
    if (typeof value !== "number") {
      continue;
    }
    const valueAlreadyShown = selected.some((existing) => areNumbersClose(existing.average_accuracy_mean, value));
    if (!valueAlreadyShown) {
      add(condition);
    }
  }
  return selected.length >= 2 ? selected : conditions.slice(0, 8);
}

function conditionSummariesReferToSameCell(
  left: PaperManuscriptConditionSummary,
  right: PaperManuscriptConditionSummary
): boolean {
  const leftCondition = cleanString(left.condition || left.label);
  const rightCondition = cleanString(right.condition || right.label);
  if (leftCondition && rightCondition && leftCondition === rightCondition) {
    return true;
  }
  const leftHasParameters = typeof left.condition_parameter_x === "number" || typeof left.condition_parameter_y === "number";
  const rightHasParameters = typeof right.condition_parameter_x === "number" || typeof right.condition_parameter_y === "number";
  if (!leftHasParameters || !rightHasParameters) {
    return false;
  }
  return (
    (typeof left.condition_parameter_x !== "number"
      || typeof right.condition_parameter_x !== "number"
      || areNumbersClose(left.condition_parameter_x, right.condition_parameter_x))
    && (typeof left.condition_parameter_y !== "number"
      || typeof right.condition_parameter_y !== "number"
      || areNumbersClose(left.condition_parameter_y, right.condition_parameter_y))
  );
}

interface ConditionAxisLabels {
  x: string;
  y: string;
}

interface BenchmarkTaskLabels {
  a: string;
  b: string;
}

function buildConditionSummaryDisplayLabel(
  condition: PaperManuscriptConditionSummary,
  index: number,
  axisLabels: ConditionAxisLabels,
  baselineComparatorMismatch = false
): string {
  const letter = String.fromCharCode(65 + Math.min(index, 25));
  const assignment = formatConditionAxisAssignment(condition, axisLabels);
  if (condition.is_registered_baseline || (condition.is_baseline && !condition.is_comparator)) {
    if (baselineComparatorMismatch) {
      return assignment
        ? `Registered baseline condition, not delta reference (${assignment})`
        : "Registered baseline condition, not delta reference";
    }
    return assignment ? `Registered baseline condition (${assignment})` : "Registered baseline condition";
  }
  if (condition.is_comparator) {
    return assignment ? `Archived reference condition (${assignment})` : "Archived reference condition";
  }
  if (typeof condition.condition_parameter_x === "number" || typeof condition.condition_parameter_y === "number") {
    return `Condition ${letter} (${assignment})`;
  }
  const raw = cleanString(condition.label || condition.condition || "");
  if (raw && !isNoisyConditionIdentifier(raw)) {
    return raw;
  }
  return `Condition ${letter}`;
}

function formatConditionAxisAssignment(
  condition: PaperManuscriptConditionSummary | PaperManuscriptVisualRow,
  axisLabels: ConditionAxisLabels
): string {
  if (typeof condition.condition_parameter_x !== "number" && typeof condition.condition_parameter_y !== "number") {
    return "";
  }
  const x = typeof condition.condition_parameter_x === "number"
    ? formatShortNumber(condition.condition_parameter_x)
    : "--";
  const y = typeof condition.condition_parameter_y === "number"
    ? formatShortNumber(condition.condition_parameter_y)
    : "--";
  return `${axisLabels.x}=${x}, ${axisLabels.y}=${y}`;
}

function inferConditionAxisLabels(conditions: Array<PaperManuscriptConditionSummary | PaperManuscriptVisualRow>): ConditionAxisLabels {
  const explicit = conditions.find((condition) => condition.condition_axis_x_label || condition.condition_axis_y_label);
  if (explicit?.condition_axis_x_label || explicit?.condition_axis_y_label) {
    return {
      x: cleanString(explicit.condition_axis_x_label) || "factor x",
      y: cleanString(explicit.condition_axis_y_label) || "factor y"
    };
  }
  return { x: "factor x", y: "factor y" };
}

function resolveConditionAxisLabelsForSubmission(
  manuscript: PaperManuscript,
  options: PaperManuscriptStabilizationOptions,
  conditionSummaries: PaperManuscriptConditionSummary[]
): ConditionAxisLabels {
  const context = collectSubmissionAxisContext(manuscript, options);
  if (/\bcondition\s+parameter\s+x\b/iu.test(context) && /\bcondition\s+parameter\s+y\b/iu.test(context)) {
    return { x: "condition parameter x", y: "condition parameter y" };
  }
  return inferConditionAxisLabels(conditionSummaries);
}

function collectSubmissionAxisContext(
  manuscript: PaperManuscript,
  options: PaperManuscriptStabilizationOptions
): string {
  const parts = [
    manuscript.title,
    manuscript.abstract,
    ...(manuscript.keywords || []),
    ...manuscript.sections.flatMap((section) => [section.heading, ...section.paragraphs]),
    ...(manuscript.appendix_sections || []).flatMap((section) => [section.heading, ...section.paragraphs]),
    ...(options.methodModelNames || [])
  ];
  const analysis = options.resultAnalysis as unknown as Record<string, unknown> | undefined;
  parts.push(compactJsonForLabelInference(analysis?.plan_context));
  parts.push(compactJsonForLabelInference(analysis?.experiment_portfolio));
  parts.push(compactJsonForLabelInference((analysis?.metrics as Record<string, unknown> | undefined)?.metadata));
  return cleanString(parts.filter(Boolean).join(" "));
}

function compactJsonForLabelInference(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  try {
    return JSON.stringify(value).slice(0, 20000);
  } catch {
    return "";
  }
}

function derivedTableUsesAxisLabels(table: PaperManuscriptTable, axisLabels: ConditionAxisLabels | undefined): boolean {
  if (!axisLabels) {
    return true;
  }
  const inferred = inferConditionAxisLabels(table.rows);
  const current = {
    x: cleanString(table.condition_axis_x_label) || inferred.x,
    y: cleanString(table.condition_axis_y_label) || inferred.y
  };
  return labelsMatch(current.x, axisLabels.x) && labelsMatch(current.y, axisLabels.y);
}

function labelsMatch(left: string, right: string): boolean {
  return normalizeLabelKey(left) === normalizeLabelKey(right);
}

function resolveBenchmarkTaskLabels(
  conditionSummaries: PaperManuscriptConditionSummary[],
  manuscript?: PaperManuscript,
  options: PaperManuscriptStabilizationOptions = {}
): BenchmarkTaskLabels {
  const firstWithLabels = conditionSummaries.find((condition) => condition.benchmark_task_a_label || condition.benchmark_task_b_label);
  const context = manuscript ? collectSubmissionAxisContext(manuscript, options) : "";
  return {
    a: resolveTaskSurfaceLabel(firstWithLabels?.benchmark_task_a_label, "Benchmark Task A", context),
    b: resolveTaskSurfaceLabel(firstWithLabels?.benchmark_task_b_label, "Benchmark Task B", context)
  };
}

function resolveTaskSurfaceLabel(rawLabel: string | undefined, fallback: string, context: string): string {
  const cleaned = cleanString(rawLabel);
  if (!cleaned) {
    return fallback;
  }
  return findSurfaceLabelInContext(cleaned, context) || humanizeBenchmarkTaskLabel(cleaned);
}

function findSurfaceLabelInContext(rawLabel: string, context: string): string | undefined {
  const target = normalizeLabelKey(rawLabel);
  if (!target || !context) {
    return undefined;
  }
  const tokens = context.match(/[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)*/gu) || [];
  for (let width = 3; width >= 1; width -= 1) {
    for (let index = 0; index <= tokens.length - width; index += 1) {
      const candidate = tokens.slice(index, index + width).join(width === 1 ? "" : " ");
      if (normalizeLabelKey(candidate) === target) {
        return candidate.replace(/_/gu, " ");
      }
    }
  }
  return undefined;
}

function humanizeBenchmarkTaskLabel(rawLabel: string): string {
  const raw = String(rawLabel || "").trim();
  const singleLetterTask = raw.match(/^task[_\s-]*([a-z])$/iu);
  if (singleLetterTask) {
    return `Benchmark Task ${singleLetterTask[1].toUpperCase()}`;
  }
  return raw
    .replace(/[_-]+/gu, " ")
    .split(/\s+/u)
    .filter(Boolean)
    .map((token) => token.length <= 3 ? token.toUpperCase() : token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

function normalizeLabelKey(value: string): string {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9]+/giu, "");
}

function figureUsesBenchmarkTaskLabels(figure: PaperManuscriptFigure, taskLabels: BenchmarkTaskLabels | undefined): boolean {
  if (!taskLabels) {
    return true;
  }
  const labels = figure.bars.map((bar) => cleanString(bar.label)).join(" ");
  return labelsMatch(labels, taskLabels.a + " " + taskLabels.b)
    || (new RegExp("\b" + escapeRegExp(taskLabels.a) + "\b", "iu").test(labels)
      && new RegExp("\b" + escapeRegExp(taskLabels.b) + "\b", "iu").test(labels));
}

function isNoisyConditionIdentifier(label: string): boolean {
  return /[_{}]|\bcondition_\d+\b|\bparameter_\d+\b/iu.test(label);
}

function isNoisyMixedMetricTable(table: PaperManuscriptTable): boolean {
  const text = [table.caption, ...table.rows.map((row) => row.label)].map(cleanString).join(" ");
  const hasMetric = /\b(?:accuracy|delta|gain|baseline)\b/iu.test(text);
  const hasAccountingRows = table.rows.some((row) =>
    /\b(?:threshold|correct|incorrect|total|predictions?|samples?|sample size|count|records?|trials?|runs?|seeds?|levels?|cells?|profiles?|coverage|present|requested|completed)\b/iu.test(row.label)
  );
  const hasLargeValues = table.rows.some((row) => Number.isFinite(row.value) && Math.abs(row.value) > 1);
  return hasMetric && (hasAccountingRows || hasLargeValues);
}

function isNoisyMixedMetricFigure(figure: PaperManuscriptFigure): boolean {
  const text = [figure.caption, ...figure.bars.map((row) => row.label)].map(cleanString).join(" ");
  const hasMetric = /\b(?:accuracy|delta|gain|baseline)\b/iu.test(text);
  const hasAccountingRows = figure.bars.some((row) =>
    /\b(?:threshold|correct|incorrect|total|predictions?|samples?|sample size|count|records?|trials?|runs?|seeds?|levels?|cells?|profiles?|coverage|present|requested|completed)\b/iu.test(row.label)
  );
  const hasLargeValues = figure.bars.some((row) => Number.isFinite(row.value) && Math.abs(row.value) > 1);
  return hasMetric && (hasAccountingRows || hasLargeValues);
}

function buildTaskLevelLeadingConditionFigure(
  conditionSummaries: PaperManuscriptConditionSummary[] | undefined,
  preferredAxisLabels?: ConditionAxisLabels,
  benchmarkTaskLabels?: BenchmarkTaskLabels
): PaperManuscriptFigure | undefined {
  if (!conditionSummaries?.length) {
    return undefined;
  }
  const candidates = conditionSummaries
    .map((condition) => ({
      ...condition,
      benchmark_task_a_accuracy: normalizeNumber(condition.benchmark_task_a_accuracy),
      benchmark_task_b_accuracy: normalizeNumber(condition.benchmark_task_b_accuracy),
      average_accuracy_mean: normalizeNumber(condition.average_accuracy_mean),
      accuracy_delta_vs_baseline_mean: normalizeNumber(condition.accuracy_delta_vs_baseline_mean)
    }))
    .filter(
      (condition) =>
        typeof condition.benchmark_task_a_accuracy === "number"
        && typeof condition.benchmark_task_b_accuracy === "number"
    );
  if (candidates.length < 2) {
    return undefined;
  }
  const axisLabels = preferredAxisLabels || inferConditionAxisLabels(candidates);
  const taskLabels = benchmarkTaskLabels || resolveBenchmarkTaskLabels(candidates);
  const baseline =
    candidates.find((condition) => condition.is_registered_baseline || (condition.is_baseline && !condition.is_comparator))
    || candidates.find((condition) => condition.is_baseline)
    || candidates.find((condition) => condition.is_comparator)
    || candidates.find((condition) => /\bbaseline\b/iu.test(
      `${condition.condition || ""} ${condition.label || ""}`
    ));
  if (
    !baseline
    || typeof baseline.benchmark_task_a_accuracy !== "number"
    || typeof baseline.benchmark_task_b_accuracy !== "number"
  ) {
    return undefined;
  }
  const leading = candidates
    .filter((condition) => condition !== baseline && !condition.is_baseline && !condition.is_registered_baseline)
    .sort((left, right) => scoreLeadingCondition(right, baseline) - scoreLeadingCondition(left, baseline))[0];
  if (
    !leading
    || typeof leading.benchmark_task_a_accuracy !== "number"
    || typeof leading.benchmark_task_b_accuracy !== "number"
  ) {
    return undefined;
  }
  const bars = [
    {
      label: taskLabels.a + " task difference",
      value: Number((leading.benchmark_task_a_accuracy - baseline.benchmark_task_a_accuracy).toFixed(6))
    },
    {
      label: taskLabels.b + " task difference",
      value: Number((leading.benchmark_task_b_accuracy - baseline.benchmark_task_b_accuracy).toFixed(6))
    }
  ];
  if (!bars.some((bar) => Math.abs(bar.value) >= 0.000001)) {
    return undefined;
  }
  if (bars.length < 2 || bars.some((bar) => !isHumanReadableMetricLabel(bar.label))) {
    return undefined;
  }
  const leadingScore = scoreLeadingCondition(leading, baseline);
  const tiedLeadingCount = candidates.filter((condition) =>
    condition !== baseline
    && !condition.is_baseline
    && !condition.is_registered_baseline
    && areNumbersClose(scoreLeadingCondition(condition, baseline), leadingScore)
  ).length;
  return {
    caption:
      `Task-level score differences for ${buildBriefConditionRoleLabel(leading, axisLabels, { tiedLeading: tiedLeadingCount > 1 })} relative to ${buildBriefConditionRoleLabel(baseline, axisLabels)}. This figure is a task-split diagnostic, not a separate aggregate-objective claim.`,
    bars,
    source_refs: [
      { kind: "artifact", id: DERIVED_MAIN_FIGURE_SOURCE_REF_ID },
      { kind: "artifact", id: "latest_results.condition_summaries" }
    ]
  };
}

function buildBriefConditionRoleLabel(
  condition: PaperManuscriptConditionSummary,
  axisLabels: ConditionAxisLabels,
  options: { tiedLeading?: boolean } = {}
): string {
  const assignment = formatConditionAxisAssignment(condition, axisLabels);
  if (condition.is_registered_baseline || (condition.is_baseline && !condition.is_comparator)) {
    return assignment ? `the registered baseline (${assignment})` : "the registered baseline";
  }
  if (condition.is_comparator) {
    return assignment ? `the archived reference condition (${assignment})` : "the archived reference condition";
  }
  if (options.tiedLeading) {
    return assignment ? `one tied leading condition (${assignment})` : "one tied leading condition";
  }
  return assignment ? `the leading condition (${assignment})` : "the leading condition";
}

function buildConditionMeanAccuracyFigure(
  conditionSummaries: PaperManuscriptConditionSummary[] | undefined,
  preferredAxisLabels?: ConditionAxisLabels,
  baselineComparatorMismatch = false
): PaperManuscriptFigure | undefined {
  const sourceConditions = conditionSummaries || [];
  const axisLabels = preferredAxisLabels || inferConditionAxisLabels(sourceConditions);
  const rows = sourceConditions
    .filter((condition) => typeof condition.average_accuracy_mean === "number")
    .slice(0, 16)
    .map((condition, index) => ({
      label: buildConditionFigureDisplayLabel(condition, index, axisLabels, baselineComparatorMismatch),
      value: Number((condition.average_accuracy_mean as number).toFixed(6)),
      ...(typeof condition.condition_parameter_x === "number"
        ? { condition_parameter_x: condition.condition_parameter_x }
        : {}),
      ...(typeof condition.condition_parameter_y === "number"
        ? { condition_parameter_y: condition.condition_parameter_y }
        : {}),
      ...(condition.is_registered_baseline || (condition.is_baseline && !condition.is_comparator)
        ? { is_baseline: true, is_registered_baseline: true }
        : {}),
      ...(condition.is_comparator ? { is_comparator: true } : {})
    }));
  if (rows.length < 4) {
    return undefined;
  }
  const distinctValues = new Set(rows.map((row) => Math.round(row.value * 10000) / 10000));
  if (distinctValues.size < 2 || !visualRowsMeetQualityGate(rows)) {
    return undefined;
  }
  return {
    caption: baselineComparatorMismatch
      ? "Condition-level mean accuracy across the executed condition-parameter grid; the registered baseline and delta-reference row are kept separate."
      : "Condition-level mean accuracy across the executed condition-parameter grid; the reported delta-reference row is marked in the table metadata.",
    bars: rows,
    source_refs: [{ kind: "artifact", id: DERIVED_MAIN_FIGURE_SOURCE_REF_ID }]
  };
}

function buildConditionFigureDisplayLabel(
  condition: PaperManuscriptConditionSummary,
  index: number,
  axisLabels: ConditionAxisLabels,
  baselineComparatorMismatch = false
): string {
  if (condition.is_registered_baseline || (condition.is_baseline && !condition.is_comparator)) {
    const assignment = formatConditionAxisAssignment(condition, axisLabels);
    if (baselineComparatorMismatch) {
      return "Registered baseline, not reference";
    }
    return assignment ? `Registered baseline (${assignment})` : "Registered baseline";
  }
  if (condition.is_comparator) {
    const assignment = formatConditionAxisAssignment(condition, axisLabels);
    return assignment ? `Archived reference condition (${assignment})` : "Archived reference condition";
  }
  if (condition.is_baseline) {
    return "Archived reference condition";
  }
  if (typeof condition.condition_parameter_x === "number" || typeof condition.condition_parameter_y === "number") {
    return formatConditionAxisAssignment(condition, axisLabels);
  }
  return `Candidate ${String.fromCharCode(65 + Math.min(index, 25))}`;
}

function scoreLeadingCondition(
  condition: PaperManuscriptConditionSummary,
  baseline: PaperManuscriptConditionSummary
): number {
  if (typeof condition.accuracy_delta_vs_baseline_mean === "number") {
    return condition.accuracy_delta_vs_baseline_mean;
  }
  if (typeof condition.average_accuracy_mean === "number" && typeof baseline.average_accuracy_mean === "number") {
    return condition.average_accuracy_mean - baseline.average_accuracy_mean;
  }
  const conditionAverage =
    typeof condition.benchmark_task_a_accuracy === "number" && typeof condition.benchmark_task_b_accuracy === "number"
      ? (condition.benchmark_task_a_accuracy + condition.benchmark_task_b_accuracy) / 2
      : Number.NEGATIVE_INFINITY;
  const baselineAverage =
    typeof baseline.benchmark_task_a_accuracy === "number" && typeof baseline.benchmark_task_b_accuracy === "number"
      ? (baseline.benchmark_task_a_accuracy + baseline.benchmark_task_b_accuracy) / 2
      : 0;
  return conditionAverage - baselineAverage;
}

function isConditionDeltaSurfaceFigure(figure: PaperManuscriptFigure): boolean {
  const caption = cleanString(figure.caption);
  const conditionParameterRows = figure.bars.filter((bar) =>
    /\b(?:condition\s+parameter|parameter|factor)\s*x\b.*\b(?:condition\s+parameter|parameter|factor)\s*y\b/iu.test(bar.label)
  ).length;
  const zeroRows = figure.bars.filter((bar) => Math.abs(bar.value) < 0.0005).length;
  return (
    /\bbaseline-relative\b.*\b(?:condition|parameter|factor)\b/iu.test(caption)
    || (figure.bars.length >= 4 && conditionParameterRows >= 3 && zeroRows >= figure.bars.length - 1)
  );
}

function isTaskLevelLeadingConditionFigure(figure: PaperManuscriptFigure): boolean {
  const caption = cleanString(figure.caption);
  const labels = figure.bars.map((bar) => cleanString(bar.label)).join(" ");
  return (
    /\btask-level (?:and average )?accuracy(?: split)?\b/iu.test(caption)
    || /\bBaseline Benchmark Task A\b.*\bLeading Benchmark Task B\b/iu.test(labels)
  );
}

function dedupeManuscriptFigures(figures: PaperManuscriptFigure[]): PaperManuscriptFigure[] {
  const seen = new Set<string>();
  const deduped: PaperManuscriptFigure[] = [];
  for (const figure of figures) {
    const key = manuscriptFigureKey(figure);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(figure);
  }
  return deduped;
}

function sameManuscriptFigure(left: PaperManuscriptFigure, right: PaperManuscriptFigure): boolean {
  return manuscriptFigureKey(left) === manuscriptFigureKey(right);
}

function manuscriptFigureKey(figure: PaperManuscriptFigure): string {
  const bars = figure.bars
    .map((bar) => `${cleanString(bar.label).toLowerCase()}:${Number(bar.value).toFixed(4)}`)
    .join("|");
  return `${cleanString(figure.caption).toLowerCase()}::${bars}`;
}

function resolveConditionSummariesForSubmission(
  options: PaperManuscriptStabilizationOptions
): PaperManuscriptConditionSummary[] {
  const analysisSummaries = conditionSummariesFromResultAnalysis(options.resultAnalysis);
  const providedSummaries = options.conditionSummaries || [];
  if (providedSummaries.length === 0) {
    return analysisSummaries;
  }
  const merged = providedSummaries.map((condition, index) => {
    const analysis = analysisSummaries[index];
    const markerParameters = parseGenericConditionParameters(condition.label || condition.condition);
    return {
      ...condition,
      label: condition.label || analysis?.label,
      condition: condition.condition || analysis?.condition,
      is_baseline: condition.is_baseline ?? analysis?.is_baseline,
      is_comparator: condition.is_comparator ?? analysis?.is_comparator,
      is_registered_baseline: condition.is_registered_baseline ?? analysis?.is_registered_baseline,
      condition_parameter_x:
        normalizeNumber(condition.condition_parameter_x)
        ?? markerParameters?.x
        ?? analysis?.condition_parameter_x,
      condition_parameter_y:
        normalizeNumber(condition.condition_parameter_y)
        ?? markerParameters?.y
        ?? analysis?.condition_parameter_y,
      average_accuracy_mean:
        normalizeNumber(condition.average_accuracy_mean)
        ?? analysis?.average_accuracy_mean,
      accuracy_delta_vs_baseline_mean:
        normalizeNumber(condition.accuracy_delta_vs_baseline_mean)
        ?? analysis?.accuracy_delta_vs_baseline_mean,
      benchmark_task_a_accuracy:
        normalizeNumber(condition.benchmark_task_a_accuracy)
        ?? analysis?.benchmark_task_a_accuracy,
      benchmark_task_b_accuracy:
        normalizeNumber(condition.benchmark_task_b_accuracy)
        ?? analysis?.benchmark_task_b_accuracy,
      benchmark_task_a_label: condition.benchmark_task_a_label || analysis?.benchmark_task_a_label,
      benchmark_task_b_label: condition.benchmark_task_b_label || analysis?.benchmark_task_b_label,
      condition_axis_x_label: condition.condition_axis_x_label || analysis?.condition_axis_x_label,
      condition_axis_y_label: condition.condition_axis_y_label || analysis?.condition_axis_y_label
    };
  });
  return [
    ...merged,
    ...analysisSummaries.slice(providedSummaries.length)
  ];
}

function conditionSummariesFromResultAnalysis(
  resultAnalysis: ResultAnalysisArtifact | undefined
): PaperManuscriptConditionSummary[] {
  const metrics = resultAnalysis?.metrics as Record<string, unknown> | undefined;
  const rawConditions = Array.isArray(resultAnalysis?.metrics?.condition_summaries)
    ? resultAnalysis?.metrics?.condition_summaries
    : resultAnalysis?.metrics?.condition_results;
  if (!Array.isArray(rawConditions)) {
    return [];
  }
  const lockedComparatorMarker = cleanString(metrics?.baseline_condition_marker);
  const registeredBaselineParameters = parseRegisteredBaselineParameters(resultAnalysis);
  const summaries = rawConditions
    .map((condition, index): PaperManuscriptConditionSummary | undefined => {
      if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
        return undefined;
      }
      const record = condition as Record<string, unknown>;
      const evaluationMetrics = extractFirstTwoEvaluationMetrics(record);
      const deltaVsBaseline = normalizeNumber(record.accuracy_delta_vs_baseline_mean ?? record.accuracy_delta_vs_baseline);
      const label =
        cleanString(record.label)
        || cleanString(record.condition_marker)
        || cleanString(record.condition)
        || cleanString(record.name);
      const conditionMarker = cleanString(record.condition_marker) || cleanString(record.marker) || cleanString(record.condition);
      const markerParameters = parseGenericConditionParameters(label || conditionMarker || record.condition || record.marker);
      const condition_parameter_x = normalizeNumber(record.condition_parameter_x) ?? markerParameters?.x;
      const condition_parameter_y = normalizeNumber(record.condition_parameter_y) ?? markerParameters?.y;
      const isLockedComparator = Boolean(
        (lockedComparatorMarker && conditionMarker && cleanString(conditionMarker) === lockedComparatorMarker)
        || record.is_comparator === true
        || record.is_locked_comparator === true
      );
      const isRegisteredBaseline = Boolean(
        record.is_registered_baseline === true
        || parametersMatch({ x: condition_parameter_x, y: condition_parameter_y }, registeredBaselineParameters)
      );
      const isFallbackBaseline = Boolean(
        record.is_baseline === true
        || /\bbaseline\b/iu.test(label)
        || (!registeredBaselineParameters && index === 0 && typeof deltaVsBaseline === "number" && Math.abs(deltaVsBaseline) < 0.000001)
      );
      return {
        label,
        condition: conditionMarker || label,
        is_baseline: isRegisteredBaseline || (isFallbackBaseline && !registeredBaselineParameters),
        is_registered_baseline: isRegisteredBaseline,
        is_comparator: isLockedComparator || (isFallbackBaseline && !isRegisteredBaseline),
        condition_parameter_x,
        condition_parameter_y,
        average_accuracy_mean: normalizeNumber(record.average_accuracy_mean ?? record.average_accuracy),
        accuracy_delta_vs_baseline_mean: deltaVsBaseline,
        benchmark_task_a_accuracy: normalizeNumber(
          record.benchmark_task_a_accuracy_mean ?? record.benchmark_task_a_accuracy ?? evaluationMetrics[0]?.accuracy
        ),
        benchmark_task_b_accuracy: normalizeNumber(
          record.benchmark_task_b_accuracy_mean ?? record.benchmark_task_b_accuracy ?? evaluationMetrics[1]?.accuracy
        ),
        benchmark_task_a_label: cleanString(record.benchmark_task_a_label) || evaluationMetrics[0]?.label,
        benchmark_task_b_label: cleanString(record.benchmark_task_b_label) || evaluationMetrics[1]?.label
      };
    })
    .filter((condition): condition is PaperManuscriptConditionSummary => Boolean(condition));
  if (summaries.some((condition) => condition.is_baseline)) {
    return summaries;
  }
  const firstZeroDelta = summaries.find((condition) => Math.abs(condition.accuracy_delta_vs_baseline_mean || 0) < 0.000001);
  if (firstZeroDelta) {
    firstZeroDelta.is_baseline = true;
    firstZeroDelta.is_comparator = true;
  }
  return summaries;
}

function parseRegisteredBaselineParameters(resultAnalysis: ResultAnalysisArtifact | undefined): { x?: number; y?: number } | undefined {
  const texts = collectRegisteredBaselineTexts(resultAnalysis);
  for (const text of texts) {
    const generic = parseGenericConditionParameters(text);
    if (generic) {
      return generic;
    }
  }
  return undefined;
}

function collectRegisteredBaselineTexts(resultAnalysis: ResultAnalysisArtifact | undefined): string[] {
  const texts: string[] = [];
  const visit = (value: unknown, keyHint = ""): void => {
    if (/\bbaseline_(?:condition_)?marker\b/iu.test(keyHint)) {
      return;
    }
    if (typeof value === "string") {
      const cleaned = cleanString(value);
      if (/\b(?:registered|primary trained|pre[-\s]?registered|baseline)\b/iu.test(`${keyHint} ${cleaned}`)) {
        texts.push(cleaned);
      }
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, keyHint));
      return;
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (/\bbaseline_(?:condition_)?marker\b/iu.test(key)) {
        continue;
      }
      const nextHint = /\b(?:baseline|baselines|registered)\b/iu.test(key) ? key : keyHint;
      visit(nested, nextHint);
    }
  };
  visit(resultAnalysis?.plan_context);
  visit(resultAnalysis?.experiment_portfolio);
  visit(resultAnalysis?.metrics);
  return uniqueStrings(texts);
}

function parametersMatch(
  condition: { x?: number; y?: number },
  target: { x?: number; y?: number } | undefined
): boolean {
  if (!target) {
    return false;
  }
  const xMatches = typeof target.x !== "number" || areNumbersClose(condition.x, target.x);
  const yMatches = typeof target.y !== "number" || areNumbersClose(condition.y, target.y);
  return xMatches && yMatches && (typeof target.x === "number" || typeof target.y === "number");
}

function areNumbersClose(left: number | undefined, right: number): boolean {
  return typeof left === "number" && Math.abs(left - right) < 0.000001;
}

function extractFirstTwoEvaluationMetrics(record: Record<string, unknown>): Array<{ label: string; accuracy: number }> {
  const evaluation = record.evaluation;
  if (!evaluation || typeof evaluation !== "object" || Array.isArray(evaluation)) {
    return [];
  }
  return Object.entries(evaluation as Record<string, unknown>)
    .map(([key, value]) => ({
      label: cleanString(key),
      accuracy: normalizeNumber((value as Record<string, unknown> | undefined)?.accuracy)
    }))
    .filter((value): value is { label: string; accuracy: number } => typeof value.accuracy === "number")
    .slice(0, 2);
}

function parseGenericConditionParameters(value: unknown): { x?: number; y?: number } | undefined {
  const text = cleanString(value).toLowerCase();
  const match = [
    /\bcondition[_:\s-]*parameter[_:\s-]*x\s*=?\s*([0-9]+(?:[._][0-9]+)*)[^0-9]+condition[_:\s-]*parameter[_:\s-]*y\s*=?\s*([0-9]+(?:[._][0-9]+)*)/iu,
    /\bfactor\s*x\s*=?\s*([0-9]+(?:[._][0-9]+)*)[^0-9]+factor\s*y\s*=?\s*([0-9]+(?:[._][0-9]+)*)/iu,
    /\bcondition[_:\s-]*([0-9]+(?:[._][0-9]+)*)[_:\s-]+parameter[_:\s-]*([0-9]+(?:[._][0-9]+)*)/iu,
    /^\s*([0-9]+(?:[._][0-9]+)?)\s+(?:parameter|param|setting)\s+([0-9]+(?:[._]?[0-9]+|\s+[0-9]+)?)\s*$/iu,
  ]
    .map((pattern) => text.match(pattern))
    .find((candidate): candidate is RegExpMatchArray => Boolean(candidate));
  if (!match) {
    return undefined;
  }
  const x = parseMarkerNumber(match[1]);
  const y = parseMarkerNumber(match[2]);
  if (typeof x !== "number" && typeof y !== "number") {
    return undefined;
  }
  return { ...(typeof x === "number" ? { x } : {}), ...(typeof y === "number" ? { y } : {}) };
}

function parseMarkerNumber(value: string | undefined): number | undefined {
  const normalized = cleanString(value).replace(/_/gu, ".");
  if (!normalized) {
    return undefined;
  }
  const compactDecimal = normalized.match(/^([0-9]+)\s+([0-9]+)$/u);
  const numericText = compactDecimal ? `${compactDecimal[1]}.${compactDecimal[2]}` : normalized;
  const numberValue = Number(numericText);
  return Number.isFinite(numberValue) ? numberValue : undefined;
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
  if (/^Evidence accounting:/iu.test(cleaned)) {
    return true;
  }
  if (
    /\b(?:this draft|available to this draft|final manuscript should cite|final paper version should include|any final paper version should include)\b/iu.test(cleaned)
    || /\b(?:final analysis should make clear|those values should be presented|should be presented in the reproducibility supplement)\b/iu.test(cleaned)
    || /\b(?:unvalidated notes|stable sources|internal repair guidance|future reporting requirements)\b/iu.test(cleaned)
  ) {
    return true;
  }
  if (
    /\bcondition\s+[0-9]+\s+parameter\s+[0-9.]+(?:\s+[0-9.]+)?\s+vs\s+condition\s+[0-9]+\s+parameter\s+[0-9.]+(?:\s+[0-9.]+)?\s+improves accuracy delta vs baseline by\s+[0-9.]+/iu.test(cleaned)
  ) {
    return true;
  }
  return (
    headingKey === "method"
    && (
      /\bEvaluation spans Training:/iu.test(cleaned)
      || /\bPreprocessing follows this order:/iu.test(cleaned)
      || /\bThe protocol records Repeat each condition/iu.test(cleaned)
      || /\baccuracy_pass_at_1_delta_vs_baseline\b/iu.test(cleaned)
      || /\baccuracy_improvement_over_baseline\b/iu.test(cleaned)
      || /\bcurrent_best_baseline\b/iu.test(cleaned)
      || /\bPaper-scale evidence floor:/iu.test(cleaned)
      || /\bCanonical-reference gate:/iu.test(cleaned)
      || /\bModels or conditions include Primary trained baseline\b/iu.test(cleaned)
      || /\bThe experimental design uses the configured condition grid from the study design\b/iu.test(cleaned)
      || /\bprimary reported score and per-task, resource, and completion metrics are retained according to the run record\b/iu.test(cleaned)
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

function removeRedundantTaskDeltaFigures(
  figures: PaperManuscriptFigure[] | undefined
): PaperManuscriptFigure[] | undefined {
  if (!figures) {
    return figures;
  }
  const filtered = figures.filter((figure) => {
    const labels = figure.bars.map((row) => cleanString(row.label)).join(" ");
    const caption = cleanString(figure.caption);
    return !(
      figure.bars.length <= 2 &&
      /benchmark_task_a|benchmark_task_b|task/i.test(`${labels} ${caption}`) &&
      /delta|gain|improvement|accuracy/i.test(`${labels} ${caption}`)
    );
  });
  return filtered.length > 0 ? filtered : undefined;
}

function repairAppendixTableLabels(
  tables: PaperManuscriptTable[] | undefined
): PaperManuscriptTable[] | undefined {
  if (!tables) {
    return tables;
  }
  return tables.map((table) => ({
    ...table,
    caption: cleanString(table.caption)
      .replace(
        /\bDesign constants and realized preflight scale\.?/giu,
        "Planned protocol constants for the condition-parameter design."
      )
      .replace(
        /\band realized preflight scale\b/giu,
        ""
      ),
    rows: table.rows.map((row) => ({
      ...row,
      label: cleanString(row.label).replace(/^Seed$/iu, "Planned protocol seed")
    }))
  }));
}

function enrichManuscriptMethodExecutionDetails(input: {
  sections: PaperManuscriptSection[];
  resultAnalysis?: ResultAnalysisArtifact;
  methodModelNames?: string[];
}): PaperManuscriptSection[] {
  const details = buildExecutedMethodDetails(input.resultAnalysis, input.methodModelNames);
  if (!details) {
    return input.sections;
  }
  const methodIndex = input.sections.findIndex((section) => normalizeHeadingKey(section.heading) === "method");
  const methodSection =
    methodIndex >= 0
      ? input.sections[methodIndex]
      : {
          heading: "Method",
          paragraphs: []
        };
  const replacement = buildExecutedMethodDetailsParagraph(details);
  const existingParagraphs = methodSection.paragraphs;
  const methodText = existingParagraphs.join(" ");
  const hasSelectedModel = details.selectedModelId ? methodText.includes(details.selectedModelId) : true;
  const hasLearningRate =
    typeof details.learningRate === "number" ? new RegExp(`learning rate\\s+${escapeRegExp(formatTexNumber(details.learningRate))}`, "iu").test(methodText) : true;
  const hasBatchSize =
    typeof details.perDeviceBatchSize === "number" ? /\bbatch size\b/iu.test(methodText) && methodText.includes(String(details.perDeviceBatchSize)) : true;
  const hasGradientAccumulation =
    typeof details.gradientAccumulationSteps === "number"
      ? /gradient accumulation/iu.test(methodText) && methodText.includes(String(details.gradientAccumulationSteps))
      : true;
  const alreadyComplete = hasSelectedModel && hasLearningRate && hasBatchSize && hasGradientAccumulation;
  const paragraphs = alreadyComplete ? existingParagraphs : insertMethodDetailParagraph(existingParagraphs, replacement);
  const enrichedSection = {
    ...methodSection,
    paragraphs,
    source_refs: mergeSectionSourceRefs(methodSection.source_refs, [
      { kind: "artifact", id: "result_analysis.metrics.run_config" }
    ])
  };
  if (methodIndex < 0) {
    return sortSections([...input.sections, enrichedSection]);
  }
  return input.sections.map((section, index) => (index === methodIndex ? enrichedSection : section));
}

interface ExecutedMethodDetails {
  selectedModelId?: string;
  preferredModelId?: string;
  fallbackModelId?: string;
  trainDataset?: string;
  evalTasks: string[];
  trainSamples?: number;
  evalSamples?: number;
  seed?: number;
  maxSteps?: number;
  perDeviceBatchSize?: number;
  gradientAccumulationSteps?: number;
  learningRate?: number;
  maxSeqLength?: number;
  timeoutSec?: number;
  targetModules: string[];
  ciLevel?: number;
  ciSampleSize?: number;
}

function buildExecutedMethodDetails(
  resultAnalysis: ResultAnalysisArtifact | undefined,
  methodModelNames: string[] = []
): ExecutedMethodDetails | undefined {
  const metrics = asPlainRecord(resultAnalysis?.metrics);
  const runConfig = asPlainRecord(metrics.run_config);
  const data = asPlainRecord(metrics.data);
  const trainData = asPlainRecord(asPlainRecord(data.train).dataset);
  const evalData = asPlainRecord(data.eval);
  const evalTasks = Object.entries(evalData)
    .map(([key, value]) => formatDatasetSpec(asPlainRecord(asPlainRecord(value).dataset), key.replace(/[_-]+/gu, " ")))
    .filter(Boolean);
  const confidenceIntervals = resultAnalysis?.statistical_summary?.confidence_intervals || [];
  const ciLevel = confidenceIntervals.find((item) => typeof item.level === "number")?.level;
  const ciSampleSize = confidenceIntervals.find((item) => typeof item.sample_size === "number")?.sample_size;
  const selectedModelId = firstLikelyModelIdentifier([
    metrics.selected_model_id,
    metrics.selected_model_name,
    asPlainRecord(metrics.model_selection).selected_model_id,
    ...methodModelNames
  ]);
  const fallbackModelId = firstLikelyModelIdentifier([
    metrics.fallback_model_id,
    metrics.fallback_model,
    ...methodModelNames.filter((item) => cleanString(item) !== selectedModelId)
  ]);
  const details: ExecutedMethodDetails = {
    selectedModelId,
    preferredModelId: cleanString(metrics.preferred_model_id) || cleanString(metrics.preferred_model),
    fallbackModelId,
    trainDataset: formatDatasetSpec(trainData, "training data"),
    evalTasks,
    trainSamples: findRunNumber(runConfig, ["train_samples", "max_train_samples"]),
    evalSamples: findRunNumber(runConfig, ["eval_samples", "max_eval_samples_per_task"]),
    seed: findRunNumber(runConfig, ["seed"]),
    maxSteps: findRunNumber(runConfig, ["max_steps", "optimizer_steps"]),
    perDeviceBatchSize: findRunNumber(runConfig, ["per_device_batch_size", "per_device_train_batch_size"]),
    gradientAccumulationSteps: findRunNumber(runConfig, ["gradient_accumulation_steps"]),
    learningRate: findRunNumber(runConfig, ["learning_rate"]),
    maxSeqLength: findRunNumber(runConfig, ["max_seq_length"]),
    timeoutSec: findRunNumber(runConfig, ["timeout_sec"]),
    targetModules: findMethodTargetModules(metrics),
    ciLevel,
    ciSampleSize
  };
  const hasMaterialDetails =
    Boolean(details.selectedModelId) ||
    typeof details.learningRate === "number" ||
    typeof details.perDeviceBatchSize === "number" ||
    typeof details.gradientAccumulationSteps === "number" ||
    typeof details.maxSeqLength === "number";
  return hasMaterialDetails ? details : undefined;
}

function buildExecutedMethodDetailsParagraph(details: ExecutedMethodDetails): string {
  const modelSentence = details.selectedModelId
    ? `The executed run used ${details.selectedModelId} as the selected backbone${details.fallbackModelId ? `, with ${details.fallbackModelId} retained only as the fallback candidate` : ""}.`
    : "The executed run used the selected local backbone recorded in the run metrics.";
  const dataBits = [
    details.trainDataset ? `training data from ${details.trainDataset}` : "",
    typeof details.trainSamples === "number" ? `${formatTexNumber(details.trainSamples)} training examples` : "",
    details.evalTasks.length > 0 ? `evaluation on ${details.evalTasks.join(" and ")}` : "",
    typeof details.evalSamples === "number" ? `${formatTexNumber(details.evalSamples)} examples per evaluation task` : "",
    typeof details.seed === "number" ? `seed ${formatTexNumber(details.seed)}` : ""
  ].filter(Boolean);
  const optimizationBits = [
    typeof details.learningRate === "number" ? `learning rate ${formatTexNumber(details.learningRate)}` : "",
    typeof details.perDeviceBatchSize === "number"
      ? `per-device train batch size ${formatTexNumber(details.perDeviceBatchSize)}`
      : "",
    typeof details.gradientAccumulationSteps === "number"
      ? `gradient accumulation ${formatTexNumber(details.gradientAccumulationSteps)}`
      : "",
    typeof details.maxSteps === "number" ? `${formatTexNumber(details.maxSteps)} optimizer steps` : "",
    typeof details.maxSeqLength === "number" ? `maximum sequence length ${formatTexNumber(details.maxSeqLength)}` : "",
    typeof details.timeoutSec === "number" ? `${formatTexNumber(details.timeoutSec)} s timeout` : "",
    details.targetModules.length > 0 ? `target modules ${details.targetModules.join(", ")}` : ""
  ].filter(Boolean);
  const ciSentence =
    typeof details.ciLevel === "number" || typeof details.ciSampleSize === "number"
      ? `Uncertainty summaries were reported as condition-level ${formatTexNumber((details.ciLevel || 0.95) * 100)}% intervals${typeof details.ciSampleSize === "number" ? ` over n=${formatTexNumber(details.ciSampleSize)} prediction records` : ""}; they are treated as screening intervals rather than significance tests.`
      : "Uncertainty summaries are treated as screening intervals rather than significance tests.";
  return [
    modelSentence,
    dataBits.length > 0 ? `The realized data and evaluation settings were ${joinAcademicList(dataBits)}.` : "",
    optimizationBits.length > 0 ? `Fixed training settings were ${joinAcademicList(optimizationBits)}.` : "",
    ciSentence
  ]
    .filter(Boolean)
    .join(" ");
}

function firstLikelyModelIdentifier(values: unknown[]): string {
  for (const value of values) {
    const candidate = cleanString(value);
    if (isLikelyModelIdentifier(candidate)) {
      return candidate;
    }
  }
  return "";
}

function isLikelyModelIdentifier(value: string): boolean {
  if (!value) {
    return false;
  }
  if (/[:.;]/u.test(value)) {
    return false;
  }
  if (
    /(?:^|[_\s-])(?:current[_\s-]*best|baseline|comparator|condition|seed|seeds|train[_\s-]*budget|same[_\s-]*evaluator|fallback[_\s-]*check)(?:$|[_\s-])/iu.test(
      value
    )
  ) {
    return false;
  }
  return /\b[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?\b/iu.test(value);
}

function insertMethodDetailParagraph(paragraphs: string[], detailParagraph: string): string[] {
  if (paragraphs.length === 0) {
    return [detailParagraph];
  }
  const insertAfter = Math.min(1, paragraphs.length - 1);
  return [
    ...paragraphs.slice(0, insertAfter + 1),
    detailParagraph,
    ...paragraphs.slice(insertAfter + 1)
  ];
}

function joinAcademicList(items: string[]): string {
  if (items.length <= 1) {
    return items.join("");
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function formatDatasetSpec(record: Record<string, unknown>, fallbackLabel: string): string {
  const path = cleanString(record.path);
  const name = cleanString(record.name);
  const split = cleanString(record.split);
  if (!path && !name) {
    return "";
  }
  const label = name && path && name !== path ? `${path}/${name}` : path || name || fallbackLabel;
  return split ? `${label} ${split} split` : label;
}

function findRunNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = normalizeNumber(record[key]);
    if (typeof value === "number") {
      return value;
    }
  }
  return undefined;
}

function findMethodTargetModules(metrics: Record<string, unknown>): string[] {
  const direct = normalizeStringArray(metrics.target_modules || metrics.modules || metrics.components);
  if (direct.length > 0) {
    return direct.slice(0, 8);
  }
  const conditions = Array.isArray(metrics.conditions) ? metrics.conditions : [];
  for (const condition of conditions) {
    const conditionRecord = asPlainRecord(condition);
    const candidates = normalizeStringArray(conditionRecord.target_modules || conditionRecord.modules || conditionRecord.components);
    if (candidates.length > 0) {
      return candidates.slice(0, 8);
    }
  }
  return [];
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
}): PaperManuscript {
  const highlights = curatePaperResultHighlights({
    resultAnalysis: input.resultAnalysis,
    objectiveEvaluation: input.objectiveEvaluation,
    objectiveMetricProfile: input.objectiveMetricProfile,
    experimentPlan: input.experimentPlan
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
  const visuals = buildAutomaticManuscriptVisuals(input.resultAnalysis, highlights);
  const appendix = buildAutomaticManuscriptAppendix(input.resultAnalysis, highlights);

  return {
    title: input.draft.title,
    abstract: input.draft.abstract,
    keywords: input.draft.keywords.slice(0, 6),
    sections: sortSections(withDiscussion),
    ...(visuals.tables.length > 0 ? { tables: visuals.tables } : {}),
    ...(visuals.figures.length > 0 ? { figures: visuals.figures } : {}),
    ...(appendix.sections.length > 0 ? { appendix_sections: appendix.sections } : {}),
    ...(appendix.tables.length > 0 ? { appendix_tables: appendix.tables } : {})
  };
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
}): CuratedPaperResultHighlights {
  const objectiveSummary =
    cleanString(input.objectiveEvaluation?.summary) ||
    cleanString(input.resultAnalysis?.objective_metric?.evaluation?.summary) ||
    cleanString(input.objectiveMetricProfile?.targetDescription);
  const comparisonTakeaways = takeSafeStrings(
    [
      ...(input.resultAnalysis?.condition_comparisons || []).map((item) => cleanString(item?.summary)),
      ...(input.resultAnalysis?.external_comparisons || []).map((item) => cleanString(item?.summary))
    ],
    2
  );

  return {
    objectiveSummary,
    selectedDesignTitle:
      cleanString(input.resultAnalysis?.plan_context?.selected_design?.title) ||
      cleanString(input.experimentPlan?.selectedTitle),
    topFindings: takeSafeStrings(input.resultAnalysis?.primary_findings || [], 3),
    comparisonTakeaways,
    limitations: takeSafeStrings(input.resultAnalysis?.limitations || [], 2),
    discussionPoints: takeSafeStrings(input.resultAnalysis?.synthesis?.discussion_points || [], 2),
    confidenceStatement: cleanString(input.resultAnalysis?.synthesis?.confidence_statement)
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
  resultAnalysis: ResultAnalysisArtifact | undefined,
  highlights: CuratedPaperResultHighlights
): {
  tables: PaperManuscriptTable[];
  figures: PaperManuscriptFigure[];
} {
  const rows = normalizeMetricRows(resultAnalysis);
  if (!visualRowsMeetQualityGate(rows)) {
    return { tables: [], figures: [] };
  }

  const compactRows = rows.slice(0, 8);
  return {
    tables: [
      {
        caption: "Selected reported metrics from the structured results analysis.",
        rows: compactRows
      }
    ],
    figures: [
      {
        caption:
          highlights.objectiveSummary ||
          "Relative metric magnitudes across the strongest reported evaluation outputs.",
        bars: compactRows
      }
    ]
  };
}

function buildAutomaticManuscriptAppendix(
  resultAnalysis: ResultAnalysisArtifact | undefined,
  highlights: CuratedPaperResultHighlights
): {
  sections: PaperManuscriptSection[];
  tables: PaperManuscriptTable[];
} {
  if (!resultAnalysis) {
    return { sections: [], tables: [] };
  }

  const executedTrials = resultAnalysis.statistical_summary?.executed_trials;
  const totalTrials = resultAnalysis.statistical_summary?.total_trials;
  const objectiveValue = resultAnalysis.objective_metric?.evaluation?.observedValue;
  const targetValue = resultAnalysis.objective_metric?.evaluation?.targetValue;
  const topComparison = resultAnalysis.condition_comparisons?.[0];
  const comparisonMetrics = (topComparison?.metrics || [])
    .filter((metric) => typeof metric.value === "number" && Number.isFinite(metric.value))
    .slice(0, 3);
  const intervals = (resultAnalysis.statistical_summary?.confidence_intervals || [])
    .filter((interval) => typeof interval.lower === "number" && typeof interval.upper === "number")
    .slice(0, 3);
  const wallClockSec = findMetricValue(resultAnalysis, ["study_summary.wall_clock_sec", "wall_clock_sec"]);
  const peakMemoryBytes = findMetricValue(resultAnalysis, [
    "study_summary.peak_memory_bytes_mean",
    "study_summary.run_peak_vram_bytes_mean",
    "peak_memory_bytes"
  ]);

  const experimentParagraphs: string[] = [];
  if (typeof executedTrials === "number" && typeof totalTrials === "number") {
    experimentParagraphs.push(
      `The executed study completed ${formatTexNumber(executedTrials)} of ${formatTexNumber(totalTrials)} scheduled runs.`
    );
  }
  if (typeof objectiveValue === "number") {
    experimentParagraphs.push(
      typeof targetValue === "number"
        ? `The observed objective value was ${formatTexNumber(objectiveValue)} against a prespecified target of ${formatTexNumber(targetValue)}.`
        : `The observed objective value was ${formatTexNumber(objectiveValue)}.`
    );
  } else if (highlights.objectiveSummary) {
    experimentParagraphs.push(sanitizeSubmissionSurfaceText(highlights.objectiveSummary));
  }
  if (topComparison && comparisonMetrics.length > 0) {
    const metricSummary = comparisonMetrics
      .map((metric) => `${humanizeMetricLabel(metric.key)} ${formatTexNumber(metric.value)}`)
      .join(", ");
    experimentParagraphs.push(`${humanizeMetricLabel(topComparison.label)}: ${metricSummary}.`);
  }

  const uncertaintyParagraphs = intervals.map(
    (interval) => `${humanizeMetricLabel(interval.metric_key)} interval: ${formatInterval(interval)}.`
  );
  const resourceParagraphs = [
    typeof wallClockSec === "number" ? `Wall-clock runtime was ${formatTexNumber(wallClockSec)} seconds.` : "",
    typeof peakMemoryBytes === "number"
      ? `Mean recorded peak memory was ${formatTexNumber(peakMemoryBytes / 1024 / 1024 / 1024)} GiB.`
      : ""
  ].filter(Boolean);

  const sections: PaperManuscriptSection[] = [
    { heading: "Supplementary Experimental Details", paragraphs: experimentParagraphs },
    { heading: "Supplementary Uncertainty", paragraphs: uncertaintyParagraphs },
    { heading: "Supplementary Resource Measurements", paragraphs: resourceParagraphs }
  ].filter((section) => section.paragraphs.length > 0);

  const rows = [
    typeof totalTrials === "number" ? { label: "Scheduled runs", value: totalTrials } : undefined,
    typeof executedTrials === "number" ? { label: "Executed runs", value: executedTrials } : undefined,
    typeof objectiveValue === "number" ? { label: "Observed objective", value: Number(objectiveValue.toFixed(4)) } : undefined,
    typeof wallClockSec === "number" ? { label: "Wall clock seconds", value: Number(wallClockSec.toFixed(4)) } : undefined,
    typeof peakMemoryBytes === "number"
      ? { label: "Mean peak memory GiB", value: Number((peakMemoryBytes / 1024 / 1024 / 1024).toFixed(4)) }
      : undefined
  ].filter((row): row is PaperManuscriptVisualRow => Boolean(row));

  return {
    sections,
    tables: rows.length > 0
      ? [{ caption: "Supplementary run accounting and resource measurements.", rows }]
      : []
  };
}

function normalizeMetricRows(
  resultAnalysis: ResultAnalysisArtifact | undefined
): PaperManuscriptVisualRow[] {
  const explicitRows = (resultAnalysis?.metric_table || [])
    .map((row) => ({
      label: humanizeMetricLabel(cleanString(row?.key)),
      value: typeof row?.value === "number" && Number.isFinite(row.value)
        ? Number(row.value.toFixed(4))
        : undefined
    }))
    .filter(
      (row): row is PaperManuscriptVisualRow =>
        Boolean(row.label) && typeof row.value === "number" && isHumanReadableMetricLabel(row.label)
    );
  return explicitRows.length > 0 ? explicitRows : flattenNumericMetrics(resultAnalysis?.metrics || {});
}

function findMetricValue(resultAnalysis: ResultAnalysisArtifact, keys: string[]): number | undefined {
  for (const key of keys) {
    const metric = (resultAnalysis.metric_table || []).find((item) => item.key === key);
    if (metric && typeof metric.value === "number" && Number.isFinite(metric.value)) {
      return metric.value;
    }
  }
  return undefined;
}

function formatInterval(interval: { lower: number; upper: number; sample_size?: number }): string {
  const sampleText = typeof interval.sample_size === "number" ? ` over n=${interval.sample_size}` : "";
  return `[${formatTexNumber(interval.lower)}, ${formatTexNumber(interval.upper)}]${sampleText}`;
}

function flattenNumericMetrics(
  value: Record<string, unknown>,
  prefix = ""
): PaperManuscriptVisualRow[] {
  const rows: PaperManuscriptVisualRow[] = [];
  for (const [key, raw] of Object.entries(value)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      const label = humanizeMetricLabel(nextKey);
      if (isHumanReadableMetricLabel(label)) {
        rows.push({ label, value: Number(raw.toFixed(4)) });
      }
      continue;
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      rows.push(...flattenNumericMetrics(raw as Record<string, unknown>, nextKey));
    }
  }
  return rows
    .sort((left, right) => Math.abs(right.value) - Math.abs(left.value))
    .slice(0, 6);
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
    return !/\b(?:present study|present contribution|this manuscript|this paper positions|positioned differently|locked comparison row|reported delta-reference row|executed run|empirical claim rests)\b/iu.test(paragraph);
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
  if (aclTemplate?.bibliographyStyleOwner === "package") {
    return null;
  }
  if (aclTemplate?.bibliographyStyleOwner === "document") {
    return ACL_BIBLIOGRAPHY_STYLE;
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
    if (isStructuredConditionTable(table)) {
      lines.push(...renderConditionResultTable(table));
      continue;
    }
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

function isStructuredConditionTable(table: PaperManuscriptTable): boolean {
  return (
    table.rows.length >= 4
    && table.rows.every((row) =>
      typeof row.condition_parameter_x === "number"
      || typeof row.condition_parameter_y === "number"
    )
  );
}

function renderConditionResultTable(table: PaperManuscriptTable): string[] {
  const inferredAxisLabels = inferConditionAxisLabels(table.rows);
  const axisLabels = {
    x: cleanString(table.condition_axis_x_label) || inferredAxisLabels.x,
    y: cleanString(table.condition_axis_y_label) || inferredAxisLabels.y
  };
  const lines: string[] = [];
  lines.push("\\begin{table*}[t]");
  lines.push("\\centering");
  lines.push("\\scriptsize");
  lines.push("\\begin{tabularx}{\\textwidth}{>{\\raggedright\\arraybackslash}X r r r r r r}");
  lines.push("\\toprule");
  lines.push(`Condition & ${latexEscape(titleCaseAxisLabel(axisLabels.x))} & ${latexEscape(titleCaseAxisLabel(axisLabels.y))} & Avg. acc. & $\\Delta$ vs comp. & Benchmark Task A & Benchmark Task B \\\\`);
  lines.push("\\midrule");
  for (const row of table.rows) {
    const parsed = parseConditionVisualRow(row);
    lines.push(
      [
        latexEscape(parsed.condition),
        parsed.parameter_x,
        parsed.parameter_y,
        formatOptionalTexNumber(parsed.averageAccuracy),
        formatSignedTexNumber(parsed.delta),
        formatOptionalTexNumber(parsed.benchmarkTaskA),
        formatOptionalTexNumber(parsed.benchmark_task_b)
      ].join(" & ") + " \\\\"
    );
  }
  lines.push("\\bottomrule");
  lines.push("\\end{tabularx}");
  lines.push(`\\caption{${latexEscape(table.caption)}}`);
  lines.push("\\end{table*}");
  lines.push("");
  return lines;
}

function parseConditionVisualRow(row: PaperManuscriptVisualRow): {
  condition: string;
  parameter_x: string;
  parameter_y: string;
  averageAccuracy: number;
  delta: number;
  benchmarkTaskA: number;
  benchmark_task_b: number;
} {
  const parameter_x = typeof row.condition_parameter_x === "number"
    ? row.condition_parameter_x
    : Number(row.label.match(/\bparameter_x\s*([0-9]+(?:\.[0-9]+)?)/iu)?.[1]);
  const parameter_y = typeof row.condition_parameter_y === "number"
    ? row.condition_parameter_y
    : Number(row.label.match(/\bparameter_y\s*([0-9]+(?:\.[0-9]+)?)/iu)?.[1]);
  const condition = row.is_registered_baseline || (row.is_baseline && !row.is_comparator)
    ? /\bnot\s+delta\s+reference\b/iu.test(row.label)
      ? "Registered baseline condition"
      : "Registered baseline"
    : row.is_comparator || /\bcomparison row\b/iu.test(row.label)
      ? "Archived reference condition"
      : cleanString(row.label) || "Candidate condition";
  return {
    condition,
    parameter_x: Number.isFinite(parameter_x) ? formatShortNumber(parameter_x) : "--",
    parameter_y: Number.isFinite(parameter_y) ? formatShortNumber(parameter_y) : "--",
    averageAccuracy: row.average_accuracy ?? row.value,
    delta: row.accuracy_delta_vs_comparator ?? row.accuracy_delta_vs_baseline ?? 0,
    benchmarkTaskA: row.benchmark_task_a_accuracy ?? Number.NaN,
    benchmark_task_b: row.benchmark_task_b_accuracy ?? Number.NaN
  };
}

function titleCaseAxisLabel(label: string): string {
  return label
    .split(/\s+/u)
    .map((token) => token ? token.charAt(0).toUpperCase() + token.slice(1) : token)
    .join(" ");
}

function formatSignedTexNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "--";
  }
  const formatted = formatTexNumber(value);
  return value > 0 ? `+${formatted}` : formatted;
}

function formatOptionalTexNumber(value: number): string {
  return Number.isFinite(value) ? formatTexNumber(value) : "--";
}

function formatShortNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "--";
  }
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
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
  const rawMetricPattern =
    /\b(?:accuracy\\?_delta\\?_vs\\?_baseline|average\\?_accuracy|benchmark_task_a\\?_accuracy|benchmark_task_b\\?_accuracy)\b/iu;
  if (rawMetricPattern.test(text)) {
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
