import type { MarkdownRunBriefSections } from "../runs/runBriefParser.js";

export interface PlannedConditionSource {
  summary?: string;
  implementation_notes?: string[];
  evaluation_steps?: string[];
  resource_notes?: string[];
  metrics?: string[];
  risks?: string[];
}

export interface PlannedConditionRequirement {
  conditionCount: number;
  tunedOnly: boolean;
}

interface CountOptions {
  tunedOnly?: boolean;
  fallbackComparisonCount?: number;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8
};

const CONDITION_NAME_KEYS = [
  "name",
  "condition",
  "condition_name",
  "condition_id",
  "id",
  "marker",
  "condition_marker",
  "recipe",
  "recipe_id",
  "recipe_name"
];

export function deriveRequiredPlannedConditionCount(
  briefSections: MarkdownRunBriefSections | undefined,
  source?: PlannedConditionSource
): PlannedConditionRequirement | undefined {
  const gateText = [
    briefSections?.minimumAcceptableEvidence,
    briefSections?.minimumExperimentPlan,
    briefSections?.paperWorthinessGate
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");
  if (!/all planned conditions|planned conditions must execute|every planned condition/iu.test(gateText)) {
    return undefined;
  }

  const text = [
    briefSections?.minimumExperimentPlan,
    briefSections?.minimumAcceptableEvidence,
    briefSections?.plan,
    briefSections?.datasetTaskBench,
    source?.summary,
    ...(source?.implementation_notes ?? []),
    ...(source?.evaluation_steps ?? []),
    ...(source?.resource_notes ?? [])
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n");

  const baselineAlternativeCount = parseBaselinePlusAlternativeCount(text);
  const conditionCount =
    parsePlannedConditionCount(text) ??
    baselineAlternativeCount ??
    parsePlannedConditionListCount(text);
  if (conditionCount === undefined) {
    return undefined;
  }

  return {
    conditionCount,
    tunedOnly:
      baselineAlternativeCount !== undefined ||
      /\btuned\s+conditions?\b|\btuned\s+baseline\b|\balternative\s+recipe\b|\brecipe\s+conditions?\b/iu.test(text)
  };
}

export function countExecutedPlannedConditions(
  metrics: Record<string, unknown>,
  options: CountOptions = {}
): number {
  const names = new Set<string>();
  const study = asRecord(metrics.study);
  addConditionNames(names, metrics.conditions, CONDITION_NAME_KEYS, options);
  addObjectConditionNames(names, metrics.conditions, options);
  addConditionNames(names, metrics.condition_results, CONDITION_NAME_KEYS, options);
  addConditionNames(names, metrics.condition_summaries, CONDITION_NAME_KEYS, options);
  addObjectConditionNames(names, metrics.condition_metrics, options);
  addObjectConditionNames(names, metrics.recipes, options);
  addObjectConditionNames(names, metrics.results, options);
  addConditionNames(names, metrics.results, CONDITION_NAME_KEYS, options);
  addConditionNames(names, metrics.result_rows, CONDITION_NAME_KEYS, options);
  addConditionNames(names, study.recipes, CONDITION_NAME_KEYS, options);
  addConditionNames(names, study.conditions, CONDITION_NAME_KEYS, options);
  addConditionNames(names, study.condition_results, CONDITION_NAME_KEYS, options);
  addConditionNames(names, study.candidate_results, CONDITION_NAME_KEYS, options);
  addConditionNames(names, study.results, CONDITION_NAME_KEYS, options);
  addObjectConditionNames(names, study.condition_metrics, options);
  addObjectConditionNames(names, study.recipes, options);
  addObjectConditionNames(names, study.results, options);
  if (names.size > 0) {
    return names.size;
  }
  return options.fallbackComparisonCount ?? 0;
}

function parsePlannedConditionCount(text: string): number | undefined {
  const numericMatches = [
    ...text.matchAll(/\b(?:all\s+)?(\d+)\s+(?:planned\s+)?(?:tuned\s+)?conditions?\b/giu),
    ...text.matchAll(/\b(?:planned\s+)?(?:tuned\s+)?conditions?\s*[:=]\s*(\d+)\b/giu)
  ]
    .map((match) => Number.parseInt(match[1], 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  const wordMatches = [...text.matchAll(/\b(?:all\s+)?(one|two|three|four|five|six|seven|eight)\s+(?:planned\s+)?(?:tuned\s+)?conditions?\b/giu)]
    .map((match) => NUMBER_WORDS[match[1]?.toLowerCase() ?? ""])
    .filter((value): value is number => typeof value === "number" && value > 0);
  const counts = [...numericMatches, ...wordMatches];
  return counts.length > 0 ? Math.max(...counts) : undefined;
}

function parseBaselinePlusAlternativeCount(text: string): number | undefined {
  const lower = text.toLowerCase();
  const baselineCount = /\bone\s+(?:named\s+)?(?:tuned\s+)?baseline\b/iu.test(text) ? 1 : 0;
  const alternativeCounts = [
    ...text.matchAll(/\b(\d+)\s+alternative(?:\s+\w+){0,3}\s+conditions?\b/giu)
  ]
    .map((match) => Number.parseInt(match[1], 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  for (const [word, value] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\s+alternative(?:\\s+\\w+){0,3}\\s+conditions?\\b`, "iu").test(lower)) {
      alternativeCounts.push(value);
    }
  }
  if (baselineCount === 0 || alternativeCounts.length === 0) {
    return undefined;
  }
  return baselineCount + Math.max(...alternativeCounts);
}

function parsePlannedConditionListCount(text: string): number | undefined {
  const match = text.match(/\bplanned\s+(?:tuned\s+)?conditions?\s*:\s*([^\n]+)/iu);
  if (!match) {
    return undefined;
  }
  const items = match[1]
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length >= 2 ? items.length : undefined;
}

function addConditionNames(
  names: Set<string>,
  value: unknown,
  keys: string[],
  options: CountOptions
): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    const row = asRecord(item);
    const name = firstPresentString(row, keys);
    if (!name || !isSuccessfulCondition(row) || isExcludedReferenceCondition(row, name, options)) {
      continue;
    }
    names.add(normalizeConditionName(name));
  }
}

function addObjectConditionNames(names: Set<string>, value: unknown, options: CountOptions): void {
  const record = asRecord(value);
  for (const [name, raw] of Object.entries(record)) {
    const row = asRecord(raw);
    if (Object.keys(row).length === 0 || !isSuccessfulCondition(row) || isExcludedReferenceCondition(row, name, options)) {
      continue;
    }
    names.add(normalizeConditionName(name));
  }
}

function isSuccessfulCondition(row: Record<string, unknown>): boolean {
  const status = asString(row.status)?.toLowerCase();
  if (!status) {
    return true;
  }
  return !["failed", "failure", "error", "errored", "skipped", "missing"].includes(status);
}

function isExcludedReferenceCondition(
  row: Record<string, unknown>,
  name: string,
  options: CountOptions
): boolean {
  if (!options.tunedOnly) {
    return false;
  }
  const labels = [
    name,
    asString(row.name),
    asString(row.condition_type),
    asString(row.type),
    asString(row.kind),
    asString(row.adapter_type),
    asString(row.recipe_type),
    asString(asRecord(row.adapter).adapter_type),
    asString(asRecord(row.adapter).method)
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  if (
    /\bbase[_\s-]?unmodified\b|\bunmodified[_\s-]?base\b|\blocked[_\s-]?untuned[_\s-]?baseline\b|\buntuned[_\s-]?baseline\b|\bunmodified\b|\buntuned\b|\bno[_\s-]?tuning\b|\bzero[_\s-]?shot\b|\bbaseline[_\s-]?unmodified[_\s-]?checkpoint\b/iu.test(labels)
  ) {
    return true;
  }
  const training = asRecord(row.training);
  const adapter = asRecord(row.adapter);
  const trainableParams =
    asNumber(training.trainable_params) ??
    asNumber(training.trainable_parameters) ??
    asNumber(adapter.trainable_params) ??
    asNumber(adapter.trainable_parameters);
  return labels.includes("baseline") && (training.skipped === true || trainableParams === 0);
}

function firstPresentString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function normalizeConditionName(value: string): string {
  return value.trim().toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
