import { createHash } from "node:crypto";

import { EventStream } from "./events.js";
import {
  candidateRawDeltaMetricKey,
  isCandidateObjectiveProfileBinding,
  objectiveComparatorForEffectCriterion,
  signedRawDeltaTargetForEffectCriterion,
  type CandidateObjectiveProfileBinding
} from "./effectCriterion.js";
import { LLMClient } from "./llm/client.js";
import { RunContextMemory } from "./memory/runContextMemory.js";
import { RunRecord } from "../types.js";

export type ObjectiveDirection = "maximize" | "minimize";
export type ObjectiveComparator = ">=" | ">" | "<=" | "<" | "==";
export type ObjectiveEvaluationStatus = "met" | "not_met" | "observed" | "missing" | "unknown";
export type ObjectiveMetricScale = "raw" | "proportion" | "percent" | "percentage_point";

export interface ObjectiveMetricComparison {
  baselineId: string;
  candidateId: string;
  metricKey?: string;
}

export interface ObjectiveResourceLimits {
  runtimeRatioMax?: number;
  memoryRatioMax?: number;
}

export interface ObjectiveMetricDeltaContract {
  output_metric_key: string;
  source_metric_key: string;
  raw_delta_definition: "subject_minus_reference";
  comparator: Exclude<ObjectiveComparator, "==">;
  signed_target: number;
}

export interface ObjectiveMetricProfile {
  source: "llm" | "heuristic_fallback";
  raw: string;
  primaryMetric?: string;
  preferredMetricKeys: string[];
  direction?: ObjectiveDirection;
  comparator?: ObjectiveComparator;
  targetValue?: number;
  targetDescription?: string;
  unit?: string;
  scale?: ObjectiveMetricScale;
  targetUnit?: string;
  targetScale?: ObjectiveMetricScale;
  comparison?: ObjectiveMetricComparison;
  resourceLimits?: ObjectiveResourceLimits;
  candidate_contract?: CandidateObjectiveProfileBinding;
  delta_contract?: ObjectiveMetricDeltaContract;
  analysisFocus: string[];
  paperEmphasis: string[];
  assumptions: string[];
}

export interface ObjectiveMetricEvaluation {
  rawObjectiveMetric: string;
  profileSource: ObjectiveMetricProfile["source"];
  primaryMetric?: string;
  preferredMetricKeys: string[];
  matchedMetricKey?: string;
  direction?: ObjectiveDirection;
  comparator?: ObjectiveComparator;
  targetValue?: number;
  unit?: string;
  scale?: ObjectiveMetricScale;
  targetUnit?: string;
  targetScale?: ObjectiveMetricScale;
  observedValue?: number;
  status: ObjectiveEvaluationStatus;
  summary: string;
}

const OBJECTIVE_PROFILE_CACHE_KEY = "objective_metric.profile";

interface StoredObjectiveMetricProfile {
  fingerprint: string;
  profile: ObjectiveMetricProfile;
  updatedAt: string;
}

interface ResolveObjectiveMetricProfileInput {
  run: RunRecord;
  runContextMemory: RunContextMemory;
  llm: LLMClient;
  eventStream?: EventStream;
  node?: string;
}

interface PartialObjectiveMetricProfile {
  source?: unknown;
  primaryMetric?: unknown;
  preferredMetricKeys?: unknown;
  direction?: unknown;
  comparator?: unknown;
  targetValue?: unknown;
  targetDescription?: unknown;
  unit?: unknown;
  scale?: unknown;
  targetUnit?: unknown;
  targetScale?: unknown;
  comparison?: unknown;
  resourceLimits?: unknown;
  candidate_contract?: unknown;
  delta_contract?: unknown;
  analysisFocus?: unknown;
  paperEmphasis?: unknown;
  assumptions?: unknown;
}

export async function resolveObjectiveMetricProfile(
  input: ResolveObjectiveMetricProfileInput
): Promise<ObjectiveMetricProfile> {
  const fingerprint = buildObjectiveMetricFingerprint(input.run);
  const cached = await input.runContextMemory.get<StoredObjectiveMetricProfile>(OBJECTIVE_PROFILE_CACHE_KEY);
  if (cached?.fingerprint === fingerprint && cached.profile) {
    return normalizeObjectiveMetricProfile(cached.profile, input.run.objectiveMetric);
  }

  const heuristicFallback = buildHeuristicObjectiveMetricProfile(input.run.objectiveMetric);
  if (!input.run.objectiveMetric.trim()) {
    await input.runContextMemory.put(OBJECTIVE_PROFILE_CACHE_KEY, {
      fingerprint,
      profile: heuristicFallback,
      updatedAt: new Date().toISOString()
    });
    return heuristicFallback;
  }

  try {
    const completion = await input.llm.complete(buildObjectiveMetricPrompt(input.run), {
      systemPrompt: buildObjectiveMetricSystemPrompt()
    });
    const parsed = parseObjectiveMetricProfileResponse(completion.text, input.run.objectiveMetric);
    const profile = normalizeObjectiveMetricProfile(
      {
        ...parsed,
        source: "llm"
      },
      input.run.objectiveMetric
    );
    await input.runContextMemory.put(OBJECTIVE_PROFILE_CACHE_KEY, {
      fingerprint,
      profile,
      updatedAt: new Date().toISOString()
    });
    return profile;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    input.eventStream?.emit({
      type: "OBS_RECEIVED",
      runId: input.run.id,
      node: input.node as RunRecord["currentNode"],
      payload: {
        text: `Objective metric profile fallback: ${message}`
      }
    });
    await input.runContextMemory.put(OBJECTIVE_PROFILE_CACHE_KEY, {
      fingerprint,
      profile: heuristicFallback,
      updatedAt: new Date().toISOString()
    });
    return heuristicFallback;
  }
}

export function buildHeuristicObjectiveMetricProfile(rawObjectiveMetric: string): ObjectiveMetricProfile {
  const raw = rawObjectiveMetric.trim();
  const threshold = parseThreshold(raw);
  const declaredMetricKey = detectDeclaredMetricKey(raw);
  const primaryMetric = declaredMetricKey;
  const preferredMetricKeys = declaredMetricKey ? [declaredMetricKey] : [];
  const direction = inferDirectionFromComparator(threshold?.comparator);
  const comparator = threshold?.comparator;
  const targetValue = threshold?.targetValue;
  const targetDescription =
    typeof targetValue === "number" && comparator
      ? `${comparator} ${targetValue}`
      : undefined;

  const analysisFocus: string[] = [];
  const paperEmphasis: string[] = [];
  if (primaryMetric) {
    analysisFocus.push(`Center the results analysis on ${primaryMetric}.`);
    paperEmphasis.push(`Highlight ${primaryMetric} in the paper results section.`);
  }
  if (targetDescription && primaryMetric) {
    const sentence = `State explicitly whether ${primaryMetric} met ${targetDescription}.`;
    analysisFocus.push(sentence);
    paperEmphasis.push(sentence);
  }

  return {
    source: "heuristic_fallback",
    raw,
    primaryMetric,
    preferredMetricKeys,
    direction,
    comparator,
    targetValue,
    targetDescription,
    unit: threshold?.targetUnit,
    scale: threshold?.targetScale,
    targetUnit: threshold?.targetUnit,
    targetScale: threshold?.targetScale,
    analysisFocus,
    paperEmphasis,
    assumptions: []
  };
}

function detectDeclaredMetricKey(text: string): string | undefined {
  const matches = [
    ...text.matchAll(/\b(?:metric|objective_metric)\s*[:=]\s*([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\b/giu),
    ...text.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\b\s*(?=>=|>|<=|<|==)/giu),
    ...text.matchAll(/^\s*([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\b\s+(?=at\s+least|more\s+than|greater\s+than|above|at\s+most|less\s+than|below|under|exactly|equal\s+to)/giu)
  ];
  const bareIdentifier = text.trim().match(/^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)$/iu)?.[1];
  const keys = dedupe([
    ...matches.map((match) => match[1]),
    ...(bareIdentifier ? [bareIdentifier] : [])
  ]);
  return keys.length === 1 ? keys[0] : undefined;
}

export function normalizeObjectiveMetricProfile(
  input: Partial<ObjectiveMetricProfile> | PartialObjectiveMetricProfile | undefined,
  rawObjectiveMetric: string
): ObjectiveMetricProfile {
  const fallback = buildHeuristicObjectiveMetricProfile(rawObjectiveMetric);
  const partial = input || {};
  const primaryMetric = hasOwn(partial, "primaryMetric")
    ? cleanString(partial.primaryMetric)
    : fallback.primaryMetric;
  const preferredMetricKeys = hasOwn(partial, "preferredMetricKeys")
    ? dedupe(normalizeStringArray(partial.preferredMetricKeys))
    : fallback.preferredMetricKeys;
  const direction = hasOwn(partial, "direction")
    ? normalizeDirection(partial.direction)
    : fallback.direction;
  const comparator = hasOwn(partial, "comparator")
    ? normalizeComparator(partial.comparator)
    : fallback.comparator;
  const targetValue = hasOwn(partial, "targetValue")
    ? normalizeNumber(partial.targetValue)
    : fallback.targetValue;
  const targetDescription = hasOwn(partial, "targetDescription")
    ? cleanString(partial.targetDescription)
    : fallback.targetDescription;
  const unit = hasOwn(partial, "unit") ? cleanString(partial.unit) : fallback.unit;
  const scale = hasOwn(partial, "scale") ? normalizeScale(partial.scale) : fallback.scale;
  const targetUnit = hasOwn(partial, "targetUnit")
    ? cleanString(partial.targetUnit)
    : fallback.targetUnit;
  const targetScale = hasOwn(partial, "targetScale")
    ? normalizeScale(partial.targetScale)
    : fallback.targetScale;
  const comparison = hasOwn(partial, "comparison")
    ? normalizeComparison(partial.comparison)
    : fallback.comparison;
  const resourceLimits = hasOwn(partial, "resourceLimits")
    ? normalizeResourceLimits(partial.resourceLimits)
    : fallback.resourceLimits;
  const candidateContract = hasOwn(partial, "candidate_contract")
    ? normalizeCandidateObjectiveContract(partial.candidate_contract)
    : undefined;
  const deltaContract = hasOwn(partial, "delta_contract")
    ? normalizeObjectiveDeltaContract(partial.delta_contract, candidateContract)
    : undefined;
  if (candidateContract && !deltaContract) {
    throw new Error("candidate_objective_delta_contract_missing");
  }
  if (deltaContract && !candidateContract) {
    throw new Error("candidate_objective_profile_binding_missing");
  }
  const analysisFocus = hasOwn(partial, "analysisFocus")
    ? normalizeStringArray(partial.analysisFocus)
    : fallback.analysisFocus;
  const paperEmphasis = hasOwn(partial, "paperEmphasis")
    ? normalizeStringArray(partial.paperEmphasis)
    : fallback.paperEmphasis;
  const assumptions = hasOwn(partial, "assumptions")
    ? normalizeStringArray(partial.assumptions)
    : fallback.assumptions;

  if (candidateContract && rawObjectiveMetric.trim() !== candidateContract.objective_raw) {
    throw new Error("candidate_objective_raw_mismatch");
  }
  const candidateMetricKey = candidateContract
    ? candidateRawDeltaMetricKey(candidateContract.primary_metric)
    : undefined;
  const candidateComparison = candidateContract
    ? {
        baselineId: comparison?.baselineId || candidateContract.comparator,
        candidateId: comparison?.candidateId || candidateContract.candidate_id,
        metricKey: candidateContract.primary_metric
      }
    : comparison;

  return {
    source: partial.source === "llm" ? "llm" : fallback.source,
    raw: rawObjectiveMetric.trim(),
    primaryMetric: candidateMetricKey || primaryMetric,
    preferredMetricKeys: candidateMetricKey
      ? [candidateMetricKey]
      : preferredMetricKeys.length > 0
        ? preferredMetricKeys
        : fallback.preferredMetricKeys,
    direction: candidateContract?.metric_direction || direction,
    comparator: deltaContract?.comparator || comparator,
    targetValue: deltaContract?.signed_target ?? targetValue,
    targetDescription,
    unit: candidateContract?.metric_unit || unit,
    scale: candidateContract?.metric_scale || scale,
    targetUnit: candidateContract?.metric_unit || targetUnit,
    targetScale: candidateContract?.effect_criterion.scale || targetScale,
    comparison: candidateComparison,
    resourceLimits,
    candidate_contract: candidateContract,
    delta_contract: deltaContract,
    analysisFocus,
    paperEmphasis,
    assumptions
  };
}

/**
 * If metrics.primary_metric is a structured object with {name, value, met, target},
 * promote it as a top-level numeric key so that findMatchingMetric can find it by name.
 * This handles metrics blobs that use baseline_metrics/routed_metrics structure
 * instead of a flat conditions array.
 */
function promotePrimaryMetric(metrics: Record<string, unknown>): Record<string, unknown> {
  const pm = metrics.primary_metric;
  if (typeof pm === "string") {
    const value = metrics.primary_value;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return metrics;
    }
    const enriched: Record<string, unknown> = { ...metrics };
    if (!(pm in enriched) || typeof enriched[pm] !== "number") {
      enriched[pm] = value;
    }
    return enriched;
  }

  if (!pm || typeof pm !== "object" || Array.isArray(pm)) {
    return metrics;
  }
  const pmObj = pm as Record<string, unknown>;
  const name = pmObj.name;
  const value = pmObj.value;
  if (typeof name !== "string" || typeof value !== "number" || !Number.isFinite(value)) {
    return metrics;
  }
  const enriched: Record<string, unknown> = { ...metrics };
  // Inject the primary metric value as a top-level key if it doesn't already exist
  if (!(name in enriched) || typeof enriched[name] !== "number") {
    enriched[name] = value;
  }
  return enriched;
}

export function evaluateObjectiveMetric(
  metrics: Record<string, unknown>,
  profile: ObjectiveMetricProfile,
  rawObjectiveMetric: string
): ObjectiveMetricEvaluation {
  const enrichedMetrics = synthesizeRelativeMetrics(metrics, profile);
  const withPrimary = promotePrimaryMetric(enrichedMetrics);
  const flattened = flattenNumericMetrics(withPrimary);
  const preferredKeys = dedupe([
    ...profile.preferredMetricKeys,
    ...(profile.primaryMetric ? [profile.primaryMetric] : [])
  ]);
  const relativeObjective = isRelativeObjectiveMetricRequest(profile, preferredKeys, rawObjectiveMetric);
  const matchableMetrics = relativeObjective
    ? flattened.filter((metric) => isRelativeMetricKey(metric.key))
    : flattened;
  const matched = findMatchingMetric(matchableMetrics, preferredKeys);

  if (!matched) {
    const directPreferred = findDirectPreferredTopLevelMetric(enrichedMetrics, preferredKeys);
    if (directPreferred && (!relativeObjective || isRelativeMetricKey(directPreferred.key))) {
      return applyObjectiveRequirementChecks(
        buildObjectiveEvaluation({
          rawObjectiveMetric,
          profile,
          preferredKeys,
          matched: directPreferred
        }),
        metrics,
        rawObjectiveMetric,
        profile
      );
    }
    return {
      rawObjectiveMetric,
      profileSource: profile.source,
      primaryMetric: profile.primaryMetric,
      preferredMetricKeys: preferredKeys,
      direction: profile.direction,
      comparator: profile.comparator,
      targetValue: profile.targetValue,
      unit: profile.unit,
      scale: profile.scale,
      targetUnit: profile.targetUnit,
      targetScale: profile.targetScale,
      status: preferredKeys.length > 0 ? "missing" : "unknown",
      summary:
        preferredKeys.length > 0
          ? `Objective metric "${profile.primaryMetric || preferredKeys[0]}" was not found in metrics.json.`
          : `Objective metric "${rawObjectiveMetric}" could not be matched to a numeric metrics key.`
    };
  }

  return applyObjectiveRequirementChecks(
    buildObjectiveEvaluation({
      rawObjectiveMetric,
      profile,
      preferredKeys,
      matched
    }),
    metrics,
    rawObjectiveMetric,
    profile
  );
}

interface ExplicitComparisonPair {
  baselineId: string;
  candidateId: string;
  baselineRecord: Record<string, unknown>;
  candidateRecord: Record<string, unknown>;
  metricKey?: string;
}

interface ComparisonArtifact {
  baselineId?: string;
  candidateId?: string;
  metricKey?: string;
  outputMetricKey?: string;
  baselineValue?: number;
  candidateValue?: number;
  delta?: number;
  baselineRecord?: Record<string, unknown>;
  candidateRecord?: Record<string, unknown>;
}

/**
 * Compute relative metrics only when one comparison pair is explicitly declared.
 * Labels, row order, and observed performance never determine comparison roles.
 */
export function synthesizeRelativeMetrics(
  metrics: Record<string, unknown>,
  profile?: ObjectiveMetricProfile
): Record<string, unknown> {
  const artifact = resolveComparisonArtifact(metrics, profile);
  const enriched: Record<string, unknown> = { ...metrics };
  if (artifact?.metricKey && typeof artifact.delta === "number") {
    addRelativeMetric(enriched, artifact.metricKey, artifact.delta, artifact.outputMetricKey);
    return enriched;
  }

  const pair = resolveExplicitComparisonPair(metrics, profile, artifact);
  if (!pair) {
    return metrics;
  }

  const baselineMetrics = collectComparableMetrics(pair.baselineRecord);
  const candidateMetrics = collectComparableMetrics(pair.candidateRecord);
  const metricKeys = pair.metricKey
    ? [pair.metricKey]
    : [...baselineMetrics.keys()].filter((key) => candidateMetrics.has(key));
  for (const metricKey of metricKeys) {
    const baselineValue = baselineMetrics.get(metricKey) ?? getConditionMetricValue(pair.baselineRecord, metricKey);
    const candidateValue = candidateMetrics.get(metricKey) ?? getConditionMetricValue(pair.candidateRecord, metricKey);
    if (baselineValue === undefined || candidateValue === undefined) {
      continue;
    }
    addRelativeMetric(enriched, metricKey, candidateValue - baselineValue, artifact?.outputMetricKey);
  }
  return enriched;
}

function addRelativeMetric(
  metrics: Record<string, unknown>,
  metricKey: string,
  delta: number,
  outputMetricKey?: string
): void {
  const keys = outputMetricKey
    ? [outputMetricKey]
    : [`${metricKey}_delta_vs_baseline`, `${metricKey}_improvement_over_baseline`];
  for (const key of keys) {
    if (typeof metrics[key] !== "number") {
      metrics[key] = delta;
    }
  }
}

function resolveComparisonArtifact(
  metrics: Record<string, unknown>,
  profile?: ObjectiveMetricProfile
): ComparisonArtifact | undefined {
  if (profile?.comparison) {
    return {
      baselineId: profile.comparison.baselineId,
      candidateId: profile.comparison.candidateId,
      metricKey: profile.comparison.metricKey
    };
  }
  const singular = [metrics.objective_comparison, metrics.comparison]
    .map(asOptionalRecord)
    .filter((value): value is Record<string, unknown> => Boolean(value));
  const plural = Array.isArray(metrics.comparisons)
    ? metrics.comparisons
        .map(asOptionalRecord)
        .filter((value): value is Record<string, unknown> => Boolean(value))
    : [];
  const artifacts = [...singular, ...plural];
  if (artifacts.length !== 1) {
    return undefined;
  }
  return normalizeComparisonArtifact(artifacts[0]);
}

function normalizeComparisonArtifact(value: Record<string, unknown>): ComparisonArtifact {
  const metricKey = firstCleanString(value.metric_key, value.metricKey);
  const baselineValue = firstFiniteNumber(value.baseline_value, value.reference_value);
  const candidateValue = firstFiniteNumber(value.candidate_value, value.treatment_value);
  const explicitDelta = firstFiniteNumber(value.delta, value.delta_value, value.observed_delta);
  return {
    baselineId: firstCleanString(value.baseline_id, value.reference_id, value.comparator_id, value.baselineId),
    candidateId: firstCleanString(value.candidate_id, value.treatment_id, value.candidateId),
    metricKey,
    outputMetricKey: firstCleanString(value.output_metric_key, value.delta_metric_key, value.outputMetricKey),
    baselineValue,
    candidateValue,
    delta:
      explicitDelta ??
      (baselineValue !== undefined && candidateValue !== undefined ? candidateValue - baselineValue : undefined),
    baselineRecord: asOptionalRecord(value.baseline) || asOptionalRecord(value.reference),
    candidateRecord: asOptionalRecord(value.candidate) || asOptionalRecord(value.treatment)
  };
}

function resolveExplicitComparisonPair(
  metrics: Record<string, unknown>,
  profile?: ObjectiveMetricProfile,
  artifact = resolveComparisonArtifact(metrics, profile)
): ExplicitComparisonPair | undefined {
  if (artifact?.baselineRecord && artifact.candidateRecord) {
    return {
      baselineId: artifact.baselineId || "declared_baseline",
      candidateId: artifact.candidateId || "declared_candidate",
      baselineRecord: artifact.baselineRecord,
      candidateRecord: artifact.candidateRecord,
      metricKey: artifact.metricKey
    };
  }
  if (
    artifact?.metricKey &&
    artifact.baselineValue !== undefined &&
    artifact.candidateValue !== undefined
  ) {
    return {
      baselineId: artifact.baselineId || "declared_baseline",
      candidateId: artifact.candidateId || "declared_candidate",
      baselineRecord: { [artifact.metricKey]: artifact.baselineValue },
      candidateRecord: { [artifact.metricKey]: artifact.candidateValue },
      metricKey: artifact.metricKey
    };
  }

  const entries = comparisonEntriesFromMetrics(metrics);
  if (artifact?.baselineId && artifact.candidateId) {
    const baseline = findEntryById(entries, artifact.baselineId);
    const candidate = findEntryById(entries, artifact.candidateId);
    if (baseline && candidate && baseline !== candidate) {
      return {
        baselineId: baseline[0],
        candidateId: candidate[0],
        baselineRecord: baseline[1],
        candidateRecord: candidate[1],
        metricKey: artifact.metricKey
      };
    }
    return undefined;
  }

  const referencePairs = entries.flatMap((candidate) => {
    const referenceId = explicitReferenceId(candidate[1]);
    const baseline = referenceId ? findEntryById(entries, referenceId) : undefined;
    return baseline && baseline !== candidate ? [{ baseline, candidate }] : [];
  });
  if (referencePairs.length === 1) {
    const [{ baseline, candidate }] = referencePairs;
    return {
      baselineId: baseline[0],
      candidateId: candidate[0],
      baselineRecord: baseline[1],
      candidateRecord: candidate[1],
      metricKey: artifact?.metricKey
    };
  }
  if (referencePairs.length > 1) {
    return undefined;
  }

  const baselines = entries.filter(([, record]) => hasExplicitBaselineRole(record));
  const candidates = entries.filter(([, record]) => hasExplicitCandidateRole(record));
  if (baselines.length !== 1 || candidates.length !== 1 || baselines[0] === candidates[0]) {
    return undefined;
  }
  return {
    baselineId: baselines[0][0],
    candidateId: candidates[0][0],
    baselineRecord: baselines[0][1],
    candidateRecord: candidates[0][1],
    metricKey: artifact?.metricKey
  };
}

function comparisonEntriesFromMetrics(
  metrics: Record<string, unknown>
): Array<[string, Record<string, unknown>]> {
  const entries: Array<[string, Record<string, unknown>]> = [];
  for (const collectionKey of ["conditions", "results"]) {
    const collection = metrics[collectionKey];
    if (Array.isArray(collection)) {
      collection.forEach((item, index) => {
        const record = asOptionalRecord(item);
        if (record) {
          entries.push([recordIdentity(record) || `${collectionKey}_${index + 1}`, record]);
        }
      });
    } else {
      const recordMap = asOptionalRecord(collection);
      if (recordMap) {
        for (const [id, item] of Object.entries(recordMap)) {
          const record = asOptionalRecord(item);
          if (record) {
            entries.push([id, record]);
          }
        }
      }
    }
  }
  const methods = asOptionalRecord(metrics.methods);
  if (methods) {
    for (const [id, item] of Object.entries(methods)) {
      const record = asOptionalRecord(item);
      if (record) {
        entries.push([id, record]);
      }
    }
  }
  const baselineMetrics = asOptionalRecord(metrics.baseline_metrics);
  const candidateMetrics = asOptionalRecord(metrics.candidate_metrics);
  if (baselineMetrics && candidateMetrics) {
    entries.push(["baseline_metrics", { ...baselineMetrics, role: "baseline" }]);
    entries.push(["candidate_metrics", { ...candidateMetrics, role: "candidate" }]);
  }
  return entries;
}

function findEntryById(
  entries: Array<[string, Record<string, unknown>]>,
  id: string
): [string, Record<string, unknown>] | undefined {
  const matches = entries.filter(([entryId, record]) => {
    const identities = [entryId, recordIdentity(record)].filter(
      (value): value is string => Boolean(value)
    );
    return identities.includes(id);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function recordIdentity(record: Record<string, unknown>): string | undefined {
  return firstCleanString(record.id, record.condition_id, record.method_id, record.name);
}

function explicitReferenceId(record: Record<string, unknown>): string | undefined {
  return firstCleanString(record.reference_id, record.baseline_id, record.comparator_id);
}

function hasExplicitBaselineRole(record: Record<string, unknown>): boolean {
  if (record.baseline === true || record.is_baseline === true) {
    return true;
  }
  const role = cleanString(record.role)?.toLowerCase();
  return role === "baseline" || role === "comparator" || role === "control" || role === "reference";
}

function hasExplicitCandidateRole(record: Record<string, unknown>): boolean {
  if (record.candidate === true || record.is_candidate === true) {
    return true;
  }
  const role = cleanString(record.role)?.toLowerCase();
  return role === "candidate" || role === "treatment" || role === "intervention";
}

function collectComparableMetrics(record: Record<string, unknown>): Map<string, number> {
  const metrics = new Map<string, number>();
  collectNumericRecordEntries(record, metrics);
  for (const nestedKey of ["evaluation", "metrics", "summary"]) {
    const nested = asOptionalRecord(record[nestedKey]);
    if (nested) {
      collectNumericRecordEntries(nested, metrics);
    }
  }
  return metrics;
}

function collectNumericRecordEntries(record: Record<string, unknown>, target: Map<string, number>): void {
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "number" && Number.isFinite(value) && !target.has(key)) {
      target.set(key, value);
    }
  }
}

function getConditionMetricValue(record: Record<string, unknown>, metricKey: string): number | undefined {
  const direct = readNumericPath(record, metricKey.split("."));
  if (direct !== undefined) {
    return direct;
  }
  for (const nestedKey of ["evaluation", "metrics", "summary"]) {
    const nested = asOptionalRecord(record[nestedKey]);
    const value = nested ? readNumericPath(nested, metricKey.split(".")) : undefined;
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function readNumericPath(record: Record<string, unknown>, path: string[]): number | undefined {
  let current: unknown = record;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "number" && Number.isFinite(current) ? current : undefined;
}

function buildObjectiveMetricSystemPrompt(): string {
  return [
    "You are the AutoLabOS objective metric planning agent.",
    "Convert the run objective metric into a strict JSON profile for execution evaluation and paper writing.",
    "Return JSON only.",
    "Do not invent a metric if the objective metric is too vague; prefer null, empty arrays, or assumptions."
  ].join("\n");
}

function buildObjectiveMetricPrompt(run: RunRecord): string {
  return [
    "Return one JSON object with this shape:",
    "{",
    '  "primaryMetric": string|null,',
    '  "preferredMetricKeys": string[],',
    '  "direction": "maximize"|"minimize"|null,',
    '  "comparator": ">="|">"|"<="|"<"|"=="|null,',
    '  "targetValue": number|null,',
    '  "targetDescription": string|null,',
    '  "unit": string|null,',
    '  "scale": "raw"|"proportion"|"percent"|"percentage_point"|null,',
    '  "targetUnit": string|null,',
    '  "targetScale": "raw"|"proportion"|"percent"|"percentage_point"|null,',
    '  "comparison": {"baselineId": string, "candidateId": string, "metricKey": string|null}|null,',
    '  "resourceLimits": {"runtimeRatioMax": number|null, "memoryRatioMax": number|null}|null,',
    '  "analysisFocus": string[],',
    '  "paperEmphasis": string[],',
    '  "assumptions": string[]',
    "}",
    "",
    "Guidance:",
    "- preferredMetricKeys must list declared metrics.json keys; do not rank any metric by default.",
    "- If the objective metric says things like 'under 200ms', extract comparator and targetValue.",
    "- Preserve signed targets and declare units/scales when the text states them.",
    "- Declare comparison IDs only when the objective explicitly identifies them.",
    "- If the objective metric is conceptual (e.g. reproducibility), keep the profile conservative and explain assumptions.",
    "",
    `Run topic: ${run.topic}`,
    `Constraints: ${run.constraints.join(", ") || "none"}`,
    `Objective metric: ${run.objectiveMetric || "none"}`
  ].join("\n");
}

function parseObjectiveMetricProfileResponse(
  raw: string,
  objectiveMetric: string
): Partial<ObjectiveMetricProfile> {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) {
    throw new Error("LLM returned no JSON object for the objective metric profile.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(
      `Objective metric profile JSON parse failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Objective metric profile JSON must decode to an object.");
  }

  return parsed as Partial<ObjectiveMetricProfile>;
}

function extractJsonObject(raw: string): string | undefined {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  const candidate = fenced?.[1] || raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  return candidate.slice(start, end + 1);
}

function buildObjectiveMetricFingerprint(run: RunRecord): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        topic: run.topic,
        constraints: run.constraints,
        objectiveMetric: run.objectiveMetric
      })
    )
    .digest("hex");
}

function flattenNumericMetrics(
  value: Record<string, unknown>,
  prefix = ""
): Array<{ key: string; value: number }> {
  const items: Array<{ key: string; value: number }> = [];
  for (const [key, raw] of Object.entries(value)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      items.push({ key: nextKey, value: raw });
      continue;
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      items.push(...flattenNumericMetrics(raw as Record<string, unknown>, nextKey));
    }
  }
  return items;
}

function findDirectPreferredTopLevelMetric(
  metrics: Record<string, unknown>,
  preferredKeys: string[]
): { key: string; value: number } | undefined {
  const normalizedTargets = preferredKeys.map(normalizeMetricKey).filter(Boolean);
  for (const key of preferredKeys) {
    const value = metrics[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return { key, value };
    }
  }
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      continue;
    }
    if (normalizedTargets.includes(normalizeMetricKey(key))) {
      return { key, value };
    }
  }
  return undefined;
}

function findMatchingMetric(
  metrics: Array<{ key: string; value: number }>,
  preferredKeys: string[]
): { key: string; value: number } | undefined {
  const normalizedTargets = preferredKeys.map(normalizeMetricKey).filter(Boolean);
  // Phase 1: exact match (after normalization)
  for (const target of normalizedTargets) {
    const exact = metrics.find((metric) => normalizeMetricKey(metric.key) === target);
    if (exact) {
      return exact;
    }
  }
  // Phase 2: partial match — only if target is specific enough (>=10 chars)
  // and the target covers a meaningful portion of the metric key
  for (const target of normalizedTargets) {
    if (target.length < 10) continue;
    const partial = metrics.find((metric) => {
      const normalized = normalizeMetricKey(metric.key);
      return normalized.includes(target) && target.length >= normalized.length * 0.4;
    });
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

function buildObjectiveEvaluation(input: {
  rawObjectiveMetric: string;
  profile: ObjectiveMetricProfile;
  preferredKeys: string[];
  matched: { key: string; value: number };
  summaryPrefix?: string;
}): ObjectiveMetricEvaluation {
  if (input.profile.comparator && typeof input.profile.targetValue === "number") {
    const targetResolution = resolveComparableTarget(input.profile);
    if (!targetResolution.ok) {
      return {
        rawObjectiveMetric: input.rawObjectiveMetric,
        profileSource: input.profile.source,
        primaryMetric: input.profile.primaryMetric,
        preferredMetricKeys: input.preferredKeys,
        matchedMetricKey: input.matched.key,
        direction: input.profile.direction,
        comparator: input.profile.comparator,
        targetValue: input.profile.targetValue,
        unit: input.profile.unit,
        scale: input.profile.scale,
        targetUnit: input.profile.targetUnit,
        targetScale: input.profile.targetScale,
        observedValue: input.matched.value,
        status: "missing",
        summary: targetResolution.summary
      };
    }
    const effectiveTarget = targetResolution.value;
    const met = compareObjectiveValue(input.matched.value, input.profile.comparator, effectiveTarget);
    const baseSummary = met
      ? `Objective metric met: ${input.matched.key}=${input.matched.value} ${input.profile.comparator} ${effectiveTarget}.`
      : `Objective metric not met: ${input.matched.key}=${input.matched.value} does not satisfy ${input.profile.comparator} ${effectiveTarget}.`;
    return {
      rawObjectiveMetric: input.rawObjectiveMetric,
      profileSource: input.profile.source,
      primaryMetric: input.profile.primaryMetric,
      preferredMetricKeys: input.preferredKeys,
      matchedMetricKey: input.matched.key,
      direction: input.profile.direction,
      comparator: input.profile.comparator,
      targetValue: effectiveTarget,
      unit: input.profile.unit,
      scale: input.profile.scale,
      targetUnit: input.profile.targetUnit,
      targetScale: input.profile.targetScale,
      observedValue: input.matched.value,
      status: met ? "met" : "not_met",
      summary: input.summaryPrefix ? `${input.summaryPrefix} ${baseSummary}` : baseSummary
    };
  }

  const baseSummary = `Observed objective metric ${input.matched.key}=${input.matched.value}.`;
  return {
    rawObjectiveMetric: input.rawObjectiveMetric,
    profileSource: input.profile.source,
    primaryMetric: input.profile.primaryMetric,
    preferredMetricKeys: input.preferredKeys,
    matchedMetricKey: input.matched.key,
    direction: input.profile.direction,
    comparator: input.profile.comparator,
    targetValue: input.profile.targetValue,
    unit: input.profile.unit,
    scale: input.profile.scale,
    targetUnit: input.profile.targetUnit,
    targetScale: input.profile.targetScale,
    observedValue: input.matched.value,
    status: "observed",
    summary: input.summaryPrefix ? `${input.summaryPrefix} ${baseSummary}` : baseSummary
  };
}

function resolveComparableTarget(
  profile: ObjectiveMetricProfile
): { ok: true; value: number } | { ok: false; summary: string } {
  const targetValue = profile.targetValue as number;
  if (profile.targetUnit && !profile.unit) {
    return {
      ok: false,
      summary: `Objective target unit "${profile.targetUnit}" cannot be aligned without an observed metric unit.`
    };
  }
  if (profile.targetUnit && profile.unit && normalizeUnit(profile.targetUnit) !== normalizeUnit(profile.unit)) {
    const converted = convertUnit(targetValue, profile.targetUnit, profile.unit);
    if (converted === undefined) {
      return {
        ok: false,
        summary: `Objective target unit "${profile.targetUnit}" is incompatible with metric unit "${profile.unit}".`
      };
    }
    const scaled = convertScale(converted, profile.targetScale, profile.scale);
    if (profile.targetScale && profile.scale && scaled === undefined) {
      return {
        ok: false,
        summary: `Objective target scale "${profile.targetScale}" is incompatible with metric scale "${profile.scale}".`
      };
    }
    return { ok: true, value: scaled ?? converted };
  }
  if (profile.targetScale && !profile.scale) {
    return {
      ok: false,
      summary: `Objective target scale "${profile.targetScale}" cannot be aligned without an observed metric scale.`
    };
  }
  const scaled = convertScale(targetValue, profile.targetScale, profile.scale);
  if (profile.targetScale && profile.scale && scaled === undefined) {
    return {
      ok: false,
      summary: `Objective target scale "${profile.targetScale}" is incompatible with metric scale "${profile.scale}".`
    };
  }
  return { ok: true, value: scaled ?? targetValue };
}

function convertScale(
  value: number,
  from: ObjectiveMetricScale | undefined,
  to: ObjectiveMetricScale | undefined
): number | undefined {
  if (!from || !to || from === to || from === "raw" || to === "raw") {
    return from === "raw" && to && to !== "raw" || to === "raw" && from && from !== "raw"
      ? undefined
      : value;
  }
  const fromHundred = from === "percent" || from === "percentage_point";
  const toHundred = to === "percent" || to === "percentage_point";
  if (fromHundred && to === "proportion") {
    return value / 100;
  }
  if (from === "proportion" && toHundred) {
    return value * 100;
  }
  return fromHundred && toHundred ? value : undefined;
}

function convertUnit(value: number, from: string, to: string): number | undefined {
  const source = normalizeUnit(from);
  const target = normalizeUnit(to);
  if (source === target) {
    return value;
  }
  if (source === "s" && target === "ms") {
    return value * 1000;
  }
  if (source === "ms" && target === "s") {
    return value / 1000;
  }
  return undefined;
}

function normalizeUnit(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (["millisecond", "milliseconds", "msec", "ms"].includes(normalized)) {
    return "ms";
  }
  if (["second", "seconds", "sec", "s"].includes(normalized)) {
    return "s";
  }
  return normalized;
}

function applyObjectiveRequirementChecks(
  evaluation: ObjectiveMetricEvaluation,
  metrics: Record<string, unknown>,
  rawObjectiveMetric: string,
  profile: ObjectiveMetricProfile
): ObjectiveMetricEvaluation {
  const requirements = collectObjectiveRequirements(metrics, rawObjectiveMetric, profile);
  if (requirements.length === 0) {
    return evaluation;
  }

  let status = evaluation.status;
  if (status === "met" || status === "observed") {
    if (requirements.some((item) => item.status === "not_met")) {
      status = "not_met";
    } else if (requirements.some((item) => item.status === "missing")) {
      status = "missing";
    }
  }

  const suffix = requirements.map((item) => item.summary).join(" ");
  return {
    ...evaluation,
    status,
    summary: suffix ? `${evaluation.summary} ${suffix}` : evaluation.summary
  };
}

function isRelativeObjectiveMetricRequest(
  profile: ObjectiveMetricProfile,
  preferredKeys: string[],
  rawObjectiveMetric: string
): boolean {
  if (preferredKeys.some(isRelativeMetricKey) || profile.comparison) {
    return true;
  }
  if (profile.source !== "heuristic_fallback") {
    return false;
  }
  const text = rawObjectiveMetric.toLowerCase();
  return /\b(delta|improvement|improve|gain|lift)\b/u.test(text) || /\b(vs|versus|over)\s+(?:a\s+|the\s+)?baseline\b/u.test(text);
}

function isRelativeMetricKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.includes("delta") || normalized.includes("improvement") || normalized.includes("gain") || normalized.includes("lift");
}

function normalizeMetricKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function compareObjectiveValue(
  observed: number,
  comparator: ObjectiveComparator,
  target: number
): boolean {
  switch (comparator) {
    case ">=":
      return observed >= target;
    case ">":
      return observed > target;
    case "<=":
      return observed <= target;
    case "<":
      return observed < target;
    case "==":
      return observed === target;
    default:
      return false;
  }
}

function parseThreshold(text: string): {
  comparator: ObjectiveComparator;
  targetValue: number;
  targetUnit?: string;
  targetScale?: ObjectiveMetricScale;
} | undefined {
  const number = "([+-]?\\d+(?:\\.\\d+)?)";
  const patterns: Array<[RegExp, ObjectiveComparator]> = [
    [new RegExp(`(?:at\\s+least|greater\\s+than\\s+or\\s+equal\\s+to|no\\s+less\\s+than|이상)\\s*${number}`, "iu"), ">="],
    [new RegExp(`(?:more\\s+than|greater\\s+than|above|초과)\\s*${number}`, "iu"), ">"],
    [new RegExp(`(?:at\\s+most|less\\s+than\\s+or\\s+equal\\s+to|no\\s+more\\s+than|이하)\\s*${number}`, "iu"), "<="],
    [new RegExp(`(?:less\\s+than|below|under|미만)\\s*${number}`, "iu"), "<"],
    [new RegExp(`(?:exactly|equal\\s+to|같은)\\s*${number}`, "iu"), "=="],
    [new RegExp(`>=\\s*${number}`, "u"), ">="],
    [new RegExp(`>\\s*${number}`, "u"), ">"],
    [new RegExp(`<=\\s*${number}`, "u"), "<="],
    [new RegExp(`<\\s*${number}`, "u"), "<"]
  ];

  const matches = patterns.flatMap(([pattern, comparator]) => {
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    return [...text.matchAll(globalPattern)].map((match) => ({
        comparator,
        targetValue: Number(match[1]),
        ...parseExplicitTargetUnit(text.slice((match.index || 0) + match[0].length))
      }));
  });
  const uniqueMatches = matches.filter((candidate, index) =>
    matches.findIndex((other) =>
      other.comparator === candidate.comparator &&
      other.targetValue === candidate.targetValue &&
      other.targetUnit === candidate.targetUnit &&
      other.targetScale === candidate.targetScale
    ) === index
  );
  if (uniqueMatches.length === 1) {
    return uniqueMatches[0];
  }
  return undefined;
}

function parseExplicitTargetUnit(suffix: string): { targetUnit?: string; targetScale?: ObjectiveMetricScale } {
  const unit = suffix
    .trim()
    .match(/^(percentage\s+points?|pp|%|percent(?:age)?|unitless|milliseconds?|ms|seconds?|s)(?:\b|$)/iu)?.[1];
  if (!unit) {
    return {};
  }
  const normalized = unit.toLowerCase();
  if (normalized === "%" || normalized.startsWith("percent")) {
    return { targetScale: normalized.startsWith("percentage point") ? "percentage_point" : "percent" };
  }
  if (normalized === "pp") {
    return { targetScale: "percentage_point" };
  }
  return { targetUnit: normalized };
}

function inferDirectionFromComparator(comparator: ObjectiveComparator | undefined): ObjectiveDirection | undefined {
  if (!comparator) {
    return undefined;
  }
  if (comparator === ">" || comparator === ">=") {
    return "maximize";
  }
  if (comparator === "<" || comparator === "<=") {
    return "minimize";
  }
  return undefined;
}

function normalizeDirection(value: unknown): ObjectiveDirection | undefined {
  return value === "maximize" || value === "minimize" ? value : undefined;
}

function normalizeComparator(value: unknown): ObjectiveComparator | undefined {
  return value === ">=" || value === ">" || value === "<=" || value === "<" || value === "==" ? value : undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(num) ? num : undefined;
}

function normalizeScale(value: unknown): ObjectiveMetricScale | undefined {
  return value === "raw" || value === "proportion" || value === "percent" || value === "percentage_point"
    ? value
    : undefined;
}

function normalizeComparison(value: unknown): ObjectiveMetricComparison | undefined {
  const record = asOptionalRecord(value);
  if (!record) {
    return undefined;
  }
  const baselineId = firstCleanString(record.baselineId, record.baseline_id, record.referenceId, record.reference_id);
  const candidateId = firstCleanString(record.candidateId, record.candidate_id, record.treatmentId, record.treatment_id);
  if (!baselineId || !candidateId || baselineId === candidateId) {
    return undefined;
  }
  return {
    baselineId,
    candidateId,
    metricKey: firstCleanString(record.metricKey, record.metric_key)
  };
}

function normalizeResourceLimits(value: unknown): ObjectiveResourceLimits | undefined {
  const record = asOptionalRecord(value);
  if (!record) {
    return undefined;
  }
  const runtimeRatioMax = firstPositiveNumber(
    record.runtimeRatioMax,
    record.runtime_ratio_max,
    record.max_runtime_ratio
  );
  const memoryRatioMax = firstPositiveNumber(
    record.memoryRatioMax,
    record.memory_ratio_max,
    record.max_memory_ratio
  );
  return runtimeRatioMax !== undefined || memoryRatioMax !== undefined
    ? { runtimeRatioMax, memoryRatioMax }
    : undefined;
}

function normalizeCandidateObjectiveContract(
  value: unknown
): CandidateObjectiveProfileBinding | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isCandidateObjectiveProfileBinding(value)) {
    throw new Error("candidate_objective_profile_binding_invalid");
  }
  return {
    ...value,
    effect_criterion: { ...value.effect_criterion }
  };
}

function normalizeObjectiveDeltaContract(
  value: unknown,
  binding: CandidateObjectiveProfileBinding | undefined
): ObjectiveMetricDeltaContract | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const record = asOptionalRecord(value);
  if (!record || !binding) {
    throw new Error("candidate_objective_delta_contract_invalid");
  }
  const expected: ObjectiveMetricDeltaContract = {
    output_metric_key: candidateRawDeltaMetricKey(binding.primary_metric),
    source_metric_key: binding.primary_metric,
    raw_delta_definition: "subject_minus_reference",
    comparator: objectiveComparatorForEffectCriterion(
      binding.metric_direction,
      binding.effect_criterion
    ),
    signed_target: signedRawDeltaTargetForEffectCriterion(
      binding.metric_direction,
      binding.effect_criterion
    )
  };
  const knownFields = new Set([
    "output_metric_key",
    "source_metric_key",
    "raw_delta_definition",
    "comparator",
    "signed_target"
  ]);
  const valid =
    Object.keys(record).every((key) => knownFields.has(key))
    && record.output_metric_key === expected.output_metric_key
    && record.source_metric_key === expected.source_metric_key
    && record.raw_delta_definition === expected.raw_delta_definition
    && record.comparator === expected.comparator
    && record.signed_target === expected.signed_target;
  if (!valid) {
    throw new Error("candidate_objective_delta_contract_invalid");
  }
  return expected;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstCleanString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const cleaned = cleanString(value);
    if (cleaned) {
      return cleaned;
    }
  }
  return undefined;
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = normalizeNumber(value);
    if (number !== undefined) {
      return number;
    }
  }
  return undefined;
}

function firstPositiveNumber(...values: unknown[]): number | undefined {
  const number = firstFiniteNumber(...values);
  return number !== undefined && number > 0 ? number : undefined;
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => cleanString(item))
    .filter((item): item is string => Boolean(item));
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function collectObjectiveRequirements(
  metrics: Record<string, unknown>,
  rawObjectiveMetric: string,
  profile: ObjectiveMetricProfile
): Array<{ status: "met" | "not_met" | "missing"; summary: string }> {
  const requirements: Array<{ status: "met" | "not_met" | "missing"; summary: string }> = [];
  if (/\bcpu[-\s]?only\b/iu.test(rawObjectiveMetric)) {
    requirements.push(describeBooleanRequirement("CPU-only requirement", resolveCpuOnlyEvidence(metrics)));
  }
  if (/\breproduc(?:ible|ibility)\b/iu.test(rawObjectiveMetric) || /\breplicab(?:le|ility)\b/iu.test(rawObjectiveMetric)) {
    requirements.push(describeBooleanRequirement("Reproducibility requirement", resolveReproducibilityEvidence(metrics)));
  }
  if (requiresResourceRegressionCheck(rawObjectiveMetric)) {
    requirements.push(describeResourceRegressionRequirement(metrics, rawObjectiveMetric, profile));
  }
  return requirements;
}

function describeBooleanRequirement(
  label: string,
  value: boolean | undefined
): { status: "met" | "not_met" | "missing"; summary: string } {
  if (value === true) {
    return { status: "met", summary: `${label} satisfied.` };
  }
  if (value === false) {
    return { status: "not_met", summary: `${label} not satisfied.` };
  }
  return { status: "missing", summary: `${label} could not be verified from metrics.json.` };
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function resolveCpuOnlyEvidence(metrics: Record<string, unknown>): boolean | undefined {
  const direct = asBoolean(metrics.cpu_only);
  if (direct !== undefined) {
    return direct;
  }
  const protocol = asRecord(metrics.protocol);
  return asBoolean(protocol.cpu_only);
}

function resolveReproducibilityEvidence(metrics: Record<string, unknown>): boolean | undefined {
  const direct = asBoolean(metrics.reproducible);
  if (direct !== undefined) {
    return direct;
  }
  const protocol = asRecord(metrics.protocol);
  const protocolFlag = asBoolean(protocol.reproducible);
  if (protocolFlag !== undefined) {
    return protocolFlag;
  }
  for (const key of ["reproducibility_evidence", "reproducibility_contract"]) {
    const evidence = asOptionalRecord(metrics[key]);
    const verified = evidence
      ? asBoolean(evidence.verified) ?? asBoolean(evidence.reproducible) ?? asBoolean(evidence.met)
      : undefined;
    if (verified !== undefined) {
      return verified;
    }
  }
  return undefined;
}

interface ResourceRegressionMetric {
  kind: "runtime" | "memory";
  label: string;
  candidateValue?: number;
  baselineValue?: number;
  ratio?: number;
}

interface ResourceRegressionComparison {
  baselineName: string;
  candidateName: string;
  metrics: ResourceRegressionMetric[];
}

function requiresResourceRegressionCheck(rawObjectiveMetric: string): boolean {
  return (
    /\b(?:runtime|run[-\s]?time|wall[-\s]?clock|latency|time|memory|gpu|vram)\b/iu.test(rawObjectiveMetric) &&
    /\b(?:regression|worse|without|unacceptable|material|preserv|cost)\b/iu.test(rawObjectiveMetric)
  );
}

function describeResourceRegressionRequirement(
  metrics: Record<string, unknown>,
  rawObjectiveMetric: string,
  profile: ObjectiveMetricProfile
): { status: "met" | "not_met" | "missing"; summary: string } {
  const comparison = selectResourceRegressionComparison(metrics, profile);
  const limits = resolveResourceLimits(metrics, profile);
  if (!comparison || !limits) {
    return {
      status: "missing",
      summary: "Resource regression requirement needs one explicit comparison pair and explicit ratio thresholds."
    };
  }

  const requiredKinds = requiredResourceKinds(rawObjectiveMetric);
  const relevantMetrics = comparison.metrics.filter((metric) => requiredKinds.has(metric.kind));
  const limitFor = (kind: ResourceRegressionMetric["kind"]): number | undefined =>
    kind === "runtime" ? limits.runtimeRatioMax : limits.memoryRatioMax;
  const missingMetrics = relevantMetrics.filter(
    (metric) => metric.ratio === undefined || limitFor(metric.kind) === undefined
  );
  const failedMetrics = relevantMetrics.filter((metric) => {
    const limit = limitFor(metric.kind);
    return typeof metric.ratio === "number" && typeof limit === "number" && metric.ratio > limit;
  });
  const ratioSummary = relevantMetrics
    .map((metric) => {
      const limit = limitFor(metric.kind);
      if (typeof metric.ratio !== "number") {
        return `${metric.kind} unavailable`;
      }
      return typeof limit === "number"
        ? `${metric.kind} ${formatRatio(metric.ratio)} (limit ${formatRatio(limit)})`
        : `${metric.kind} ${formatRatio(metric.ratio)} (threshold undeclared)`;
    })
    .join(", ");
  const pair = `${comparison.candidateName} vs ${comparison.baselineName}`;

  if (failedMetrics.length > 0) {
    return {
      status: "not_met",
      summary: `Resource regression requirement not satisfied for ${pair}: ${ratioSummary}.`
    };
  }
  if (missingMetrics.length > 0) {
    return {
      status: "missing",
      summary: `Resource regression requirement could not be fully verified for ${pair}: ${ratioSummary}.`
    };
  }
  return {
    status: "met",
    summary: `Resource regression requirement satisfied for ${pair}: ${ratioSummary}.`
  };
}

function resolveResourceLimits(
  metrics: Record<string, unknown>,
  profile: ObjectiveMetricProfile
): ObjectiveResourceLimits | undefined {
  if (profile.resourceLimits) {
    return profile.resourceLimits;
  }
  const resourceRegression = asOptionalRecord(metrics.resource_regression);
  const candidates = [
    asOptionalRecord(metrics.resource_limits),
    resourceRegression ? asOptionalRecord(resourceRegression.limits) : undefined,
    resourceRegression ? asOptionalRecord(resourceRegression.thresholds) : undefined,
    resourceRegression
  ].filter((value): value is Record<string, unknown> => Boolean(value));
  if (candidates.length === 0) {
    return undefined;
  }
  const limits = normalizeResourceLimits(candidates[0]);
  return limits && (limits.runtimeRatioMax !== undefined || limits.memoryRatioMax !== undefined)
    ? limits
    : undefined;
}

function requiredResourceKinds(rawObjectiveMetric: string): Set<ResourceRegressionMetric["kind"]> {
  const kinds = new Set<ResourceRegressionMetric["kind"]>();
  if (/\b(?:runtime|run[-\s]?time|wall[-\s]?clock|latency|time)\b/iu.test(rawObjectiveMetric)) {
    kinds.add("runtime");
  }
  if (/\b(?:memory|gpu|vram)\b/iu.test(rawObjectiveMetric)) {
    kinds.add("memory");
  }
  if (kinds.size === 0) {
    kinds.add("runtime");
    kinds.add("memory");
  }
  return kinds;
}

function selectResourceRegressionComparison(
  metrics: Record<string, unknown>,
  profile: ObjectiveMetricProfile
): ResourceRegressionComparison | undefined {
  const pair = resolveExplicitComparisonPair(metrics, profile);
  if (!pair) {
    return undefined;
  }
  return {
    baselineName: pair.baselineId,
    candidateName: pair.candidateId,
    metrics: [
      compareResourceMetric("runtime", "runtime", pair.baselineRecord, pair.candidateRecord),
      compareResourceMetric("memory", "memory", pair.baselineRecord, pair.candidateRecord)
    ]
  };
}

function compareResourceMetric(
  kind: ResourceRegressionMetric["kind"],
  label: string,
  baselineRecord: Record<string, unknown>,
  candidateRecord: Record<string, unknown>
): ResourceRegressionMetric {
  const paths = kind === "runtime" ? RUNTIME_METRIC_PATHS : MEMORY_METRIC_PATHS;
  const baseline = readFirstNumericPath(baselineRecord, paths);
  const candidate = readFirstNumericPath(candidateRecord, paths);
  const ratio =
    typeof baseline?.value === "number" &&
    baseline.value > 0 &&
    typeof candidate?.value === "number"
      ? candidate.value / baseline.value
      : undefined;
  return {
    kind,
    label,
    baselineValue: baseline?.value,
    candidateValue: candidate?.value,
    ratio
  };
}

const RUNTIME_METRIC_PATHS = [
  ["wall_clock_sec"],
  ["wall_clock_seconds"],
  ["runtime_sec"],
  ["run_time_sec"],
  ["elapsed_sec"],
  ["duration_sec"],
  ["training", "train_runtime_sec"],
  ["training", "trainer_metrics", "train_runtime"],
  ["trainer_metrics", "train_runtime"]
];

const MEMORY_METRIC_PATHS = [
  ["peak_gpu_memory_bytes"],
  ["peak_memory_bytes"],
  ["max_memory_allocated_bytes"],
  ["cuda_max_memory_allocated_bytes"],
  ["device_info_end", "cuda_max_memory_allocated_bytes"],
  ["device_info_final", "cuda_max_memory_allocated_bytes"],
  ["training", "peak_gpu_memory_bytes"],
  ["training", "cuda_max_memory_allocated_bytes"]
];

function readFirstNumericPath(
  record: Record<string, unknown>,
  paths: string[][]
): { key: string; value: number } | undefined {
  for (const pathParts of paths) {
    let current: unknown = record;
    for (const part of pathParts) {
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        current = undefined;
        break;
      }
      current = (current as Record<string, unknown>)[part];
    }
    if (typeof current === "number" && Number.isFinite(current)) {
      return { key: pathParts.join("."), value: current };
    }
  }
  return undefined;
}

function formatRatio(value: number): string {
  return `${value.toFixed(2)}x`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
