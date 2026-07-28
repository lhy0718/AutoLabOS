import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { performance } from "node:perf_hooks";

import { hashCanonical } from "./canonicalHash.js";

export type TopicProbeComputeStage = "bounded_probe" | "confirmatory";
export type TopicProbeComputeExecutionKind =
  | "gpu_execution"
  | "cpu_execution"
  | "cache_hit";

export interface TopicProbeComputeStageLimit {
  max_gpu_hours: number;
  max_concurrent_gpus: number;
  max_trials: number;
}

export interface TopicProbeComputeBudgetLimits {
  bounded_probe: TopicProbeComputeStageLimit;
  confirmatory: TopicProbeComputeStageLimit;
}

export interface TopicProbeComputeBudgetContract {
  schema_version: 1;
  artifact_kind: "topic_probe_compute_budget_contract";
  generated_at: string;
  run_id: string;
  stage: TopicProbeComputeStage;
  active_topic_probe_contract_sha256: string;
  local_budget_sha256: string;
  brief_compute_budget_ceiling: TopicProbeComputeBudgetLimits;
  limits: TopicProbeComputeBudgetLimits;
  active_limit: TopicProbeComputeStageLimit;
  content_sha256: string;
}

export interface TopicProbeComputeUsageEvidence {
  schema_version: 1;
  execution_kind: TopicProbeComputeExecutionKind;
  actual_gpu_count: number;
  fresh_executed_trials: number;
  cached_trials: number;
}

interface TopicProbeComputeLedgerEntryBase {
  schema_version: 1;
  artifact_kind: "topic_probe_compute_usage_ledger_entry";
  run_id: string;
  stage: TopicProbeComputeStage;
  budget_contract_sha256: string;
  sequence: number;
  previous_entry_sha256: string | null;
  attempt: number;
  profile: string;
  command_sha256: string;
  recorded_at: string;
  content_sha256: string;
}

export interface TopicProbeComputePreflightEntry
  extends TopicProbeComputeLedgerEntryBase {
  event_kind: "preflight_estimate";
  estimated_wall_time_ms: number;
  estimated_gpu_count: number;
  estimated_gpu_hours: number;
  estimated_fresh_trials: number;
  prior_actual_gpu_hours: number;
  prior_fresh_executed_trials: number;
  projected_gpu_hours: number;
  projected_fresh_executed_trials: number;
  decision: "allowed" | "rejected";
  reason_codes: string[];
}

export interface TopicProbeComputeActualUsageEntry
  extends TopicProbeComputeLedgerEntryBase {
  event_kind: "actual_usage";
  started_at: string;
  finished_at: string;
  wall_time_ms: number;
  execution_kind: TopicProbeComputeExecutionKind;
  actual_gpu_count: number;
  gpu_hours: number;
  fresh_executed_trials: number;
  cached_trials: number;
  usage_evidence_sha256: string;
  cumulative_gpu_hours: number;
  cumulative_fresh_executed_trials: number;
  within_budget: boolean;
  reason_codes: string[];
}

export interface TopicProbeComputeUnverifiableUsageEntry
  extends TopicProbeComputeLedgerEntryBase {
  event_kind: "usage_unverifiable";
  started_at: string;
  finished_at: string;
  wall_time_ms: number;
  reason_codes: string[];
}

export type TopicProbeComputeUsageLedgerEntry =
  | TopicProbeComputePreflightEntry
  | TopicProbeComputeActualUsageEntry
  | TopicProbeComputeUnverifiableUsageEntry;

export interface TopicProbeComputeUsageLedgerValidation {
  valid: boolean;
  reasons: string[];
  entries: TopicProbeComputeUsageLedgerEntry[];
  cumulativeGpuHours: number;
  cumulativeFreshExecutedTrials: number;
  previousEntrySha256: string | null;
  nextSequence: number;
  nextAttempt: number;
  pendingAttempt?: number;
  blocked: boolean;
}

export interface TopicProbeComputePreflightResult {
  allowed: boolean;
  reasons: string[];
  entry?: TopicProbeComputePreflightEntry;
  validation: TopicProbeComputeUsageLedgerValidation;
}

export interface TopicProbeComputeActualUsageResult {
  allowed: boolean;
  reasons: string[];
  entry: TopicProbeComputeActualUsageEntry;
  validation: TopicProbeComputeUsageLedgerValidation;
}

export interface TopicProbeComputeUnverifiableUsageResult {
  allowed: false;
  reasons: string[];
  entry: TopicProbeComputeUnverifiableUsageEntry;
  validation: TopicProbeComputeUsageLedgerValidation;
}

const STAGE_NAMES: TopicProbeComputeStage[] = [
  "bounded_probe",
  "confirmatory"
];

const NUMBER_WORDS = new Map<string, number>([
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
  ["thirteen", 13],
  ["fourteen", 14],
  ["fifteen", 15],
  ["sixteen", 16],
  ["seventeen", 17],
  ["eighteen", 18],
  ["nineteen", 19],
  ["twenty", 20]
]);

const NUMBER_TOKEN = String.raw`(?:\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)`;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BUDGET_LIMIT_FIELDS = new Set([
  "max_gpu_hours",
  "max_concurrent_gpus",
  "max_trials"
]);
const BUDGET_LIMITS_FIELDS = new Set(STAGE_NAMES);
const USAGE_EVIDENCE_FIELDS = new Set([
  "schema_version",
  "execution_kind",
  "actual_gpu_count",
  "fresh_executed_trials",
  "cached_trials"
]);
const LEDGER_FILE_LOCK_SUFFIX = ".lock";
const LEDGER_LOCK_ACQUIRE_TIMEOUT_MS = 1_000;
const LEDGER_LOCK_STALE_AFTER_MS = 30_000;
const LEDGER_LOCK_INITIAL_RETRY_MS = 10;
const LEDGER_LOCK_MAX_RETRY_MS = 100;
const LEDGER_LOCK_MAX_RETRY_ATTEMPTS = 16;
const PROCESS_LEDGER_LOCKS = new Map<string, Promise<void>>();

export function parseTopicProbeComputeBudgetDeclaration(
  declaration: string
): TopicProbeComputeBudgetLimits {
  const normalized = declaration.trim();
  if (!normalized) {
    throw new Error("topic_probe_compute_budget_declaration_missing");
  }

  if (normalized.startsWith("{")) {
    return parseStructuredBudgetDeclaration(normalized);
  }

  const values = {
    bounded_probe: {
      gpuHours: [] as number[],
      maxGpus: [] as number[],
      maxTrials: [] as number[]
    },
    confirmatory: {
      gpuHours: [] as number[],
      maxGpus: [] as number[],
      maxTrials: [] as number[]
    }
  };
  collectExplicitAssignments(normalized, values);
  collectNaturalGpuHours(normalized, values);
  collectNaturalGpuCounts(normalized, values);
  collectNaturalTrialCaps(normalized, values);

  const boundedProbe = resolveStageLimit("bounded_probe", values.bounded_probe);
  const confirmatory = resolveStageLimit("confirmatory", values.confirmatory);
  return {
    bounded_probe: boundedProbe,
    confirmatory
  };
}

export function topicProbeComputeBudgetLimitsEqual(
  left: TopicProbeComputeBudgetLimits,
  right: TopicProbeComputeBudgetLimits
): boolean {
  return hashCanonical(left) === hashCanonical(right);
}

export function topicProbeComputeBudgetFitsWithin(
  candidate: TopicProbeComputeBudgetLimits,
  ceiling: TopicProbeComputeBudgetLimits
): boolean {
  return STAGE_NAMES.every((stage) =>
    candidate[stage].max_gpu_hours <= ceiling[stage].max_gpu_hours
    && candidate[stage].max_concurrent_gpus
      <= ceiling[stage].max_concurrent_gpus
    && candidate[stage].max_trials <= ceiling[stage].max_trials
  );
}

export function parseTopicProbeComputeBudgetCeilingFromBrief(
  rawBrief: string
): TopicProbeComputeBudgetLimits {
  const match = rawBrief.match(
    /machine-readable compute ceiling\s*:\s*`?(\{[^\r\n]+\})`?/iu
  );
  if (!match?.[1]) {
    throw new Error("topic_probe_compute_budget_brief_ceiling_missing");
  }
  try {
    return parseTopicProbeComputeBudgetDeclaration(match[1]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`topic_probe_compute_budget_brief_ceiling_invalid:${reason}`);
  }
}

export function isTopicProbeComputeBudgetLimits(
  value: unknown
): value is TopicProbeComputeBudgetLimits {
  if (!isRecord(value) || !hasOnlyKnownFields(value, BUDGET_LIMITS_FIELDS)) {
    return false;
  }
  return STAGE_NAMES.every((stage) => isStageLimit(value[stage]));
}

export function buildTopicProbeComputeBudgetContract(input: {
  runId: string;
  stage: TopicProbeComputeStage;
  activeTopicProbeContractSha256: string;
  localBudget: string;
  briefComputeBudgetCeiling: TopicProbeComputeBudgetLimits;
  limits: TopicProbeComputeBudgetLimits;
  generatedAt?: string;
}): TopicProbeComputeBudgetContract {
  if (!hasText(input.runId)) {
    throw new Error("topic_probe_compute_budget_contract_run_id_missing");
  }
  if (!STAGE_NAMES.includes(input.stage)) {
    throw new Error("topic_probe_compute_budget_contract_stage_invalid");
  }
  if (!isSha256(input.activeTopicProbeContractSha256)) {
    throw new Error(
      "topic_probe_compute_budget_contract_active_contract_hash_invalid"
    );
  }
  if (!hasText(input.localBudget)) {
    throw new Error(
      "topic_probe_compute_budget_contract_local_budget_missing"
    );
  }
  if (!isTopicProbeComputeBudgetLimits(input.limits)) {
    throw new Error("topic_probe_compute_budget_contract_limits_invalid");
  }
  if (!isTopicProbeComputeBudgetLimits(input.briefComputeBudgetCeiling)) {
    throw new Error(
      "topic_probe_compute_budget_contract_brief_ceiling_invalid"
    );
  }
  if (
    !topicProbeComputeBudgetFitsWithin(
      input.limits,
      input.briefComputeBudgetCeiling
    )
  ) {
    throw new Error(
      "topic_probe_compute_budget_contract_exceeds_brief_ceiling"
    );
  }
  const reparsed = parseTopicProbeComputeBudgetDeclaration(input.localBudget);
  if (!topicProbeComputeBudgetLimitsEqual(reparsed, input.limits)) {
    throw new Error(
      "topic_probe_compute_budget_contract_declaration_mismatch"
    );
  }

  const payload = {
    schema_version: 1 as const,
    artifact_kind: "topic_probe_compute_budget_contract" as const,
    generated_at: input.generatedAt || new Date().toISOString(),
    run_id: input.runId.trim(),
    stage: input.stage,
    active_topic_probe_contract_sha256:
      input.activeTopicProbeContractSha256,
    local_budget_sha256: sha256Utf8(input.localBudget.trim()),
    brief_compute_budget_ceiling: cloneBudgetLimits(
      input.briefComputeBudgetCeiling
    ),
    limits: cloneBudgetLimits(input.limits),
    active_limit: { ...input.limits[input.stage] }
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

export function validateTopicProbeComputeBudgetContract(
  value: unknown,
  expected: {
    runId?: string;
    stage?: TopicProbeComputeStage;
    activeTopicProbeContractSha256?: string;
    localBudget?: string;
    briefComputeBudgetCeiling?: TopicProbeComputeBudgetLimits;
  } = {}
): { valid: boolean; reasons: string[]; contract?: TopicProbeComputeBudgetContract } {
  if (!isTopicProbeComputeBudgetContract(value)) {
    return {
      valid: false,
      reasons: ["topic_probe_compute_budget_contract_schema_invalid"]
    };
  }
  const reasons: string[] = [];
  const { content_sha256: contentSha256, ...payload } = value;
  if (hashCanonical(payload) !== contentSha256) {
    reasons.push("topic_probe_compute_budget_contract_content_hash_mismatch");
  }
  if (expected.runId !== undefined && value.run_id !== expected.runId) {
    reasons.push("topic_probe_compute_budget_contract_run_id_mismatch");
  }
  if (expected.stage !== undefined && value.stage !== expected.stage) {
    reasons.push("topic_probe_compute_budget_contract_stage_mismatch");
  }
  if (
    expected.activeTopicProbeContractSha256 !== undefined
    && value.active_topic_probe_contract_sha256
      !== expected.activeTopicProbeContractSha256
  ) {
    reasons.push(
      "topic_probe_compute_budget_contract_active_contract_hash_mismatch"
    );
  }
  if (expected.localBudget !== undefined) {
    if (
      value.local_budget_sha256
        !== sha256Utf8(expected.localBudget.trim())
    ) {
      reasons.push(
        "topic_probe_compute_budget_contract_local_budget_hash_mismatch"
      );
    }
    try {
      const expectedLimits = parseTopicProbeComputeBudgetDeclaration(
        expected.localBudget
      );
      if (!topicProbeComputeBudgetLimitsEqual(expectedLimits, value.limits)) {
        reasons.push(
          "topic_probe_compute_budget_contract_declaration_mismatch"
        );
      }
    } catch {
      reasons.push(
        "topic_probe_compute_budget_contract_local_budget_invalid"
      );
    }
  }
  if (
    hashCanonical(value.active_limit)
    !== hashCanonical(value.limits[value.stage])
  ) {
    reasons.push(
      "topic_probe_compute_budget_contract_active_limit_mismatch"
    );
  }
  if (
    !topicProbeComputeBudgetFitsWithin(
      value.limits,
      value.brief_compute_budget_ceiling
    )
  ) {
    reasons.push(
      "topic_probe_compute_budget_contract_exceeds_brief_ceiling"
    );
  }
  if (
    expected.briefComputeBudgetCeiling !== undefined
    && !topicProbeComputeBudgetLimitsEqual(
      value.brief_compute_budget_ceiling,
      expected.briefComputeBudgetCeiling
    )
  ) {
    reasons.push(
      "topic_probe_compute_budget_contract_brief_ceiling_mismatch"
    );
  }
  return {
    valid: reasons.length === 0,
    reasons: uniqueStrings(reasons),
    contract: value
  };
}

export function parseTopicProbeComputeUsageEvidence(
  metrics: unknown
): TopicProbeComputeUsageEvidence {
  if (!isRecord(metrics)) {
    throw new Error("topic_probe_compute_usage_metrics_invalid");
  }
  const value = metrics.compute_usage;
  if (
    !isRecord(value)
    || !hasOnlyKnownFields(value, USAGE_EVIDENCE_FIELDS)
    || value.schema_version !== 1
    || !isExecutionKind(value.execution_kind)
    || !isNonNegativeInteger(value.actual_gpu_count)
    || !isNonNegativeInteger(value.fresh_executed_trials)
    || !isNonNegativeInteger(value.cached_trials)
  ) {
    throw new Error("topic_probe_compute_usage_evidence_schema_invalid");
  }

  const evidence: TopicProbeComputeUsageEvidence = {
    schema_version: 1,
    execution_kind: value.execution_kind,
    actual_gpu_count: value.actual_gpu_count,
    fresh_executed_trials: value.fresh_executed_trials,
    cached_trials: value.cached_trials
  };
  if (!isUsageEvidenceKindConsistent(evidence)) {
    throw new Error(
      "topic_probe_compute_usage_evidence_execution_kind_mismatch"
    );
  }
  return evidence;
}

export function validateTopicProbeComputeUsageLedger(
  raw: string,
  contract: TopicProbeComputeBudgetContract
): TopicProbeComputeUsageLedgerValidation {
  const reasons: string[] = [];
  const entries: TopicProbeComputeUsageLedgerEntry[] = [];
  const lines = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  let previousEntrySha256: string | null = null;
  let cumulativeGpuHours = 0;
  let cumulativeFreshExecutedTrials = 0;
  let pendingPreflight: TopicProbeComputePreflightEntry | undefined;
  let preflightCount = 0;
  let blocked = false;

  for (let index = 0; index < lines.length; index += 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[index]);
    } catch {
      reasons.push(
        `topic_probe_compute_usage_ledger_invalid_json:${index + 1}`
      );
      continue;
    }
    if (!isLedgerEntry(parsed)) {
      reasons.push(
        `topic_probe_compute_usage_ledger_schema_invalid:${index + 1}`
      );
      continue;
    }
    const entry = parsed;
    entries.push(entry);
    const { content_sha256: contentSha256, ...payload } = entry;
    if (hashCanonical(payload) !== contentSha256) {
      reasons.push(
        `topic_probe_compute_usage_ledger_content_hash_mismatch:${index + 1}`
      );
    }
    if (entry.sequence !== index + 1) {
      reasons.push(
        `topic_probe_compute_usage_ledger_sequence_mismatch:${index + 1}`
      );
    }
    if (entry.previous_entry_sha256 !== previousEntrySha256) {
      reasons.push(
        `topic_probe_compute_usage_ledger_previous_hash_mismatch:${index + 1}`
      );
    }
    if (
      entry.run_id !== contract.run_id
      || entry.stage !== contract.stage
      || entry.budget_contract_sha256 !== contract.content_sha256
    ) {
      reasons.push(
        `topic_probe_compute_usage_ledger_contract_binding_mismatch:${index + 1}`
      );
    }
    if (blocked) {
      reasons.push(
        `topic_probe_compute_usage_ledger_entry_after_terminal_block:${index + 1}`
      );
    }

    if (entry.event_kind === "preflight_estimate") {
      preflightCount += 1;
      if (
        pendingPreflight !== undefined
        || entry.attempt !== preflightCount
      ) {
        reasons.push(
          `topic_probe_compute_usage_ledger_preflight_order_invalid:${index + 1}`
        );
      }
      if (
        entry.prior_actual_gpu_hours !== cumulativeGpuHours
        || entry.prior_fresh_executed_trials
          !== cumulativeFreshExecutedTrials
        || entry.estimated_gpu_hours
          !== gpuHours(entry.estimated_wall_time_ms, entry.estimated_gpu_count)
        || entry.projected_gpu_hours
          !== sumGpuHours(cumulativeGpuHours, entry.estimated_gpu_hours)
        || entry.projected_fresh_executed_trials
          !== cumulativeFreshExecutedTrials
            + entry.estimated_fresh_trials
      ) {
        reasons.push(
          `topic_probe_compute_usage_ledger_preflight_recomputed_field_mismatch:${index + 1}`
        );
      }
      const expectedReasons = evaluateProjectedBudget(
        contract.active_limit,
        entry.projected_gpu_hours,
        entry.estimated_gpu_count,
        entry.projected_fresh_executed_trials
      );
      if (
        entry.decision
          !== (expectedReasons.length === 0 ? "allowed" : "rejected")
        || !stringArraysEqual(entry.reason_codes, expectedReasons)
      ) {
        reasons.push(
          `topic_probe_compute_usage_ledger_preflight_decision_mismatch:${index + 1}`
        );
      }
      if (entry.decision === "allowed") {
        pendingPreflight = entry;
      } else {
        blocked = true;
      }
    } else {
      const reservedGpuCount = pendingPreflight?.estimated_gpu_count;
      if (pendingPreflight === undefined) {
        reasons.push(
          `topic_probe_compute_usage_ledger_actual_without_preflight:${index + 1}`
        );
      } else if (
        entry.attempt !== pendingPreflight.attempt
        || entry.profile !== pendingPreflight.profile
        || entry.command_sha256 !== pendingPreflight.command_sha256
      ) {
        reasons.push(
          `topic_probe_compute_usage_ledger_preflight_binding_mismatch:${index + 1}`
        );
      }
      pendingPreflight = undefined;
      if (entry.event_kind === "actual_usage") {
        const computedGpuHours = gpuHours(
          entry.wall_time_ms,
          entry.actual_gpu_count
        );
        const computedCumulativeGpuHours = sumGpuHours(
          cumulativeGpuHours,
          computedGpuHours
        );
        const computedCumulativeTrials =
          cumulativeFreshExecutedTrials + entry.fresh_executed_trials;
        const expectedReasons = evaluateActualBudget(
          contract.active_limit,
          computedCumulativeGpuHours,
          entry.actual_gpu_count,
          computedCumulativeTrials,
          reservedGpuCount
        );
        if (
          entry.gpu_hours !== computedGpuHours
          || entry.cumulative_gpu_hours !== computedCumulativeGpuHours
          || entry.cumulative_fresh_executed_trials
            !== computedCumulativeTrials
          || entry.within_budget !== (expectedReasons.length === 0)
          || !stringArraysEqual(entry.reason_codes, expectedReasons)
        ) {
          reasons.push(
            `topic_probe_compute_usage_ledger_actual_recomputed_field_mismatch:${index + 1}`
          );
        }
        cumulativeGpuHours = computedCumulativeGpuHours;
        cumulativeFreshExecutedTrials = computedCumulativeTrials;
        if (!entry.within_budget) {
          blocked = true;
        }
      } else {
        blocked = true;
      }
    }
    previousEntrySha256 = entry.content_sha256;
  }

  return {
    valid: reasons.length === 0,
    reasons: uniqueStrings(reasons),
    entries,
    cumulativeGpuHours,
    cumulativeFreshExecutedTrials,
    previousEntrySha256,
    nextSequence: entries.length + 1,
    nextAttempt: preflightCount + 1,
    ...(pendingPreflight !== undefined
      ? { pendingAttempt: pendingPreflight.attempt }
      : {}),
    blocked
  };
}

type TopicProbeComputePreflightAppendInput = {
  ledgerPath: string;
  contract: TopicProbeComputeBudgetContract;
  profile: string;
  command: string;
  estimatedWallTimeMs: number;
  estimatedGpuCount: number;
  estimatedFreshTrials?: number;
  recordedAt?: string;
};

type TopicProbeComputeActualUsageAppendInput = {
  ledgerPath: string;
  contract: TopicProbeComputeBudgetContract;
  profile: string;
  command: string;
  startedAt: string;
  finishedAt?: string;
  wallTimeMs: number;
  evidence: TopicProbeComputeUsageEvidence;
  usageEvidenceSha256: string;
  recordedAt?: string;
};

type TopicProbeComputeUnverifiableUsageAppendInput = {
  ledgerPath: string;
  contract: TopicProbeComputeBudgetContract;
  profile: string;
  command: string;
  startedAt: string;
  finishedAt?: string;
  wallTimeMs: number;
  reasonCodes: string[];
  recordedAt?: string;
};

export async function appendTopicProbeComputePreflight(
  input: TopicProbeComputePreflightAppendInput
): Promise<TopicProbeComputePreflightResult> {
  return withTopicProbeComputeLedgerLock(
    input.ledgerPath,
    () => appendTopicProbeComputePreflightWithLockHeld(input)
  );
}

async function appendTopicProbeComputePreflightWithLockHeld(
  input: TopicProbeComputePreflightAppendInput
): Promise<TopicProbeComputePreflightResult> {
  const existing = await readLedger(input.ledgerPath);
  const validation = validateTopicProbeComputeUsageLedger(
    existing,
    input.contract
  );
  const readinessReasons = ledgerAppendReadinessReasons(validation);
  if (
    !isNonNegativeFinite(input.estimatedWallTimeMs)
    || !isNonNegativeInteger(input.estimatedGpuCount)
  ) {
    readinessReasons.push(
      "topic_probe_compute_preflight_estimate_invalid"
    );
  }
  if (input.estimatedFreshTrials === undefined) {
    readinessReasons.push(
      "topic_probe_compute_preflight_trial_estimate_missing"
    );
  } else if (!isNonNegativeInteger(input.estimatedFreshTrials)) {
    readinessReasons.push(
      "topic_probe_compute_preflight_trial_estimate_invalid"
    );
  }
  if (readinessReasons.length > 0) {
    return {
      allowed: false,
      reasons: uniqueStrings(readinessReasons),
      validation
    };
  }
  const estimatedFreshTrials = input.estimatedFreshTrials as number;

  const estimatedGpuHours = gpuHours(
    input.estimatedWallTimeMs,
    input.estimatedGpuCount
  );
  const projectedGpuHours = sumGpuHours(
    validation.cumulativeGpuHours,
    estimatedGpuHours
  );
  const projectedFreshTrials =
    validation.cumulativeFreshExecutedTrials + estimatedFreshTrials;
  const reasonCodes = evaluateProjectedBudget(
    input.contract.active_limit,
    projectedGpuHours,
    input.estimatedGpuCount,
    projectedFreshTrials
  );
  const payload = {
    ...buildLedgerBase({
      contract: input.contract,
      validation,
      attempt: validation.nextAttempt,
      profile: input.profile,
      command: input.command,
      recordedAt: input.recordedAt
    }),
    event_kind: "preflight_estimate" as const,
    estimated_wall_time_ms: input.estimatedWallTimeMs,
    estimated_gpu_count: input.estimatedGpuCount,
    estimated_gpu_hours: estimatedGpuHours,
    estimated_fresh_trials: estimatedFreshTrials,
    prior_actual_gpu_hours: validation.cumulativeGpuHours,
    prior_fresh_executed_trials:
      validation.cumulativeFreshExecutedTrials,
    projected_gpu_hours: projectedGpuHours,
    projected_fresh_executed_trials: projectedFreshTrials,
    decision: reasonCodes.length === 0
      ? "allowed" as const
      : "rejected" as const,
    reason_codes: reasonCodes
  };
  const entry = withContentHash(payload);
  await appendLedgerLine(input.ledgerPath, entry);
  const updated = validateTopicProbeComputeUsageLedger(
    await readLedger(input.ledgerPath),
    input.contract
  );
  return {
    allowed: entry.decision === "allowed" && updated.valid,
    reasons: uniqueStrings([
      ...entry.reason_codes,
      ...updated.reasons
    ]),
    entry,
    validation: updated
  };
}

export async function appendTopicProbeComputeActualUsage(
  input: TopicProbeComputeActualUsageAppendInput
): Promise<TopicProbeComputeActualUsageResult> {
  return withTopicProbeComputeLedgerLock(
    input.ledgerPath,
    () => appendTopicProbeComputeActualUsageWithLockHeld(input)
  );
}

async function appendTopicProbeComputeActualUsageWithLockHeld(
  input: TopicProbeComputeActualUsageAppendInput
): Promise<TopicProbeComputeActualUsageResult> {
  const existing = await readLedger(input.ledgerPath);
  const validation = validateTopicProbeComputeUsageLedger(
    existing,
    input.contract
  );
  const pendingPreflight = requirePendingAttempt(
    validation,
    input.profile,
    input.command
  );
  if (!isNonNegativeFinite(input.wallTimeMs)) {
    throw new Error("topic_probe_compute_actual_wall_time_invalid");
  }
  if (!isSha256(input.usageEvidenceSha256)) {
    throw new Error(
      "topic_probe_compute_actual_usage_evidence_hash_invalid"
    );
  }
  const gpuHoursUsed = gpuHours(
    input.wallTimeMs,
    input.evidence.actual_gpu_count
  );
  const cumulativeGpuHours = sumGpuHours(
    validation.cumulativeGpuHours,
    gpuHoursUsed
  );
  const cumulativeFreshTrials =
    validation.cumulativeFreshExecutedTrials
    + input.evidence.fresh_executed_trials;
  const reasonCodes = evaluateActualBudget(
    input.contract.active_limit,
    cumulativeGpuHours,
    input.evidence.actual_gpu_count,
    cumulativeFreshTrials,
    pendingPreflight.estimated_gpu_count
  );
  const payload = {
    ...buildLedgerBase({
      contract: input.contract,
      validation,
      attempt: validation.pendingAttempt!,
      profile: input.profile,
      command: input.command,
      recordedAt: input.recordedAt
    }),
    event_kind: "actual_usage" as const,
    started_at: input.startedAt,
    finished_at: input.finishedAt || new Date().toISOString(),
    wall_time_ms: input.wallTimeMs,
    execution_kind: input.evidence.execution_kind,
    actual_gpu_count: input.evidence.actual_gpu_count,
    gpu_hours: gpuHoursUsed,
    fresh_executed_trials: input.evidence.fresh_executed_trials,
    cached_trials: input.evidence.cached_trials,
    usage_evidence_sha256: input.usageEvidenceSha256,
    cumulative_gpu_hours: cumulativeGpuHours,
    cumulative_fresh_executed_trials: cumulativeFreshTrials,
    within_budget: reasonCodes.length === 0,
    reason_codes: reasonCodes
  };
  const entry = withContentHash(payload);
  await appendLedgerLine(input.ledgerPath, entry);
  const updated = validateTopicProbeComputeUsageLedger(
    await readLedger(input.ledgerPath),
    input.contract
  );
  return {
    allowed: entry.within_budget && updated.valid,
    reasons: uniqueStrings([
      ...entry.reason_codes,
      ...updated.reasons
    ]),
    entry,
    validation: updated
  };
}

export async function appendTopicProbeComputeUnverifiableUsage(
  input: TopicProbeComputeUnverifiableUsageAppendInput
): Promise<TopicProbeComputeUnverifiableUsageResult> {
  return withTopicProbeComputeLedgerLock(
    input.ledgerPath,
    () => appendTopicProbeComputeUnverifiableUsageWithLockHeld(input)
  );
}

async function appendTopicProbeComputeUnverifiableUsageWithLockHeld(
  input: TopicProbeComputeUnverifiableUsageAppendInput
): Promise<TopicProbeComputeUnverifiableUsageResult> {
  const existing = await readLedger(input.ledgerPath);
  const validation = validateTopicProbeComputeUsageLedger(
    existing,
    input.contract
  );
  requirePendingAttempt(validation, input.profile, input.command);
  const reasonCodes = uniqueStrings(input.reasonCodes);
  if (reasonCodes.length === 0) {
    reasonCodes.push("topic_probe_compute_usage_unverifiable");
  }
  const payload = {
    ...buildLedgerBase({
      contract: input.contract,
      validation,
      attempt: validation.pendingAttempt!,
      profile: input.profile,
      command: input.command,
      recordedAt: input.recordedAt
    }),
    event_kind: "usage_unverifiable" as const,
    started_at: input.startedAt,
    finished_at: input.finishedAt || new Date().toISOString(),
    wall_time_ms: isNonNegativeFinite(input.wallTimeMs)
      ? input.wallTimeMs
      : 0,
    reason_codes: reasonCodes
  };
  const entry = withContentHash(payload);
  await appendLedgerLine(input.ledgerPath, entry);
  const updated = validateTopicProbeComputeUsageLedger(
    await readLedger(input.ledgerPath),
    input.contract
  );
  return {
    allowed: false,
    reasons: uniqueStrings([...reasonCodes, ...updated.reasons]),
    entry,
    validation: updated
  };
}

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseStructuredBudgetDeclaration(
  raw: string
): TopicProbeComputeBudgetLimits {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("topic_probe_compute_budget_declaration_invalid_json");
  }
  if (!isTopicProbeComputeBudgetLimits(value)) {
    throw new Error(
      "topic_probe_compute_budget_declaration_schema_invalid"
    );
  }
  return cloneBudgetLimits(value);
}

function collectExplicitAssignments(
  text: string,
  values: Record<
    TopicProbeComputeStage,
    { gpuHours: number[]; maxGpus: number[]; maxTrials: number[] }
  >
): void {
  for (const stage of STAGE_NAMES) {
    collectExplicitField(
      text,
      stage,
      "max_gpu_hours",
      values[stage].gpuHours
    );
    collectExplicitField(
      text,
      stage,
      "max_concurrent_gpus",
      values[stage].maxGpus
    );
    collectExplicitField(
      text,
      stage,
      "max_trials",
      values[stage].maxTrials
    );
  }
}

function collectExplicitField(
  text: string,
  stage: TopicProbeComputeStage,
  field: string,
  target: number[]
): void {
  const pattern = new RegExp(
    String.raw`\b${stage}(?:[._]|\s+)${field}\s*[:=]\s*(${NUMBER_TOKEN})`,
    "giu"
  );
  for (const match of text.matchAll(pattern)) {
    target.push(parseNumberToken(match[1]));
  }
}

function collectNaturalGpuHours(
  text: string,
  values: Record<
    TopicProbeComputeStage,
    { gpuHours: number[]; maxGpus: number[]; maxTrials: number[] }
  >
): void {
  const stageMentions = collectStageMentions(text);
  const gpuHourPattern = new RegExp(
    String.raw`(${NUMBER_TOKEN})\s*(?:aggregate\s+)?gpu[-\s]?hours?\b`,
    "giu"
  );
  let observed = 0;
  for (const match of text.matchAll(gpuHourPattern)) {
    observed += 1;
    const stage = nearestPrecedingStage(
      stageMentions,
      match.index ?? -1
    );
    if (!stage) {
      throw new Error(
        "topic_probe_compute_budget_gpu_hours_stage_ambiguous"
      );
    }
    values[stage].gpuHours.push(parseNumberToken(match[1]));
  }
  if (/gpu[-\s]?hours?\b/iu.test(text) && observed === 0) {
    throw new Error(
      "topic_probe_compute_budget_gpu_hours_value_ambiguous"
    );
  }
}

function collectNaturalGpuCounts(
  text: string,
  values: Record<
    TopicProbeComputeStage,
    { gpuHours: number[]; maxGpus: number[]; maxTrials: number[] }
  >
): void {
  const stageMentions = collectStageMentions(text);
  const pattern = new RegExp(
    String.raw`(?:at\s+most|maximum(?:\s+of)?|no\s+more\s+than)\s+(${NUMBER_TOKEN})(?:(?!gpu[-\s]?hours?).){0,80}\bgpus?\b(?![-\s]?hours?)`,
    "giu"
  );
  let observed = 0;
  for (const match of text.matchAll(pattern)) {
    observed += 1;
    const stage = nearestPrecedingStage(
      stageMentions,
      match.index ?? -1
    );
    if (!stage) {
      throw new Error(
        "topic_probe_compute_budget_max_concurrent_gpus_stage_ambiguous"
      );
    }
    values[stage].maxGpus.push(parseNumberToken(match[1]));
  }
  if (
    /\bgpus?\b(?![-\s]?hours?)/iu.test(text)
    && /\b(?:at\s+most|maximum|no\s+more\s+than)\b/iu.test(text)
    && observed === 0
  ) {
    throw new Error(
      "topic_probe_compute_budget_max_concurrent_gpus_ambiguous"
    );
  }
}

function collectNaturalTrialCaps(
  text: string,
  values: Record<
    TopicProbeComputeStage,
    { gpuHours: number[]; maxGpus: number[]; maxTrials: number[] }
  >
): void {
  const stageMentions = collectStageMentions(text);
  const pattern = new RegExp(
    String.raw`(?:at\s+most|maximum(?:\s+of)?|no\s+more\s+than)\s+(${NUMBER_TOKEN})\s+(?:fresh\s+)?(?:trials?|runs?|executions?|repetitions?)\b`,
    "giu"
  );
  let observed = 0;
  for (const match of text.matchAll(pattern)) {
    observed += 1;
    const stage = nearestPrecedingStage(
      stageMentions,
      match.index ?? -1
    );
    if (!stage) {
      throw new Error(
        "topic_probe_compute_budget_trial_limit_stage_ambiguous"
      );
    }
    values[stage].maxTrials.push(parseNumberToken(match[1]));
  }
  if (
    /\b(?:trials?|runs?|executions?|repetitions?)\b/iu.test(text)
    && /\b(?:at\s+most|maximum|no\s+more\s+than)\b/iu.test(text)
    && observed === 0
  ) {
    throw new Error("topic_probe_compute_budget_trial_limit_ambiguous");
  }
}

function collectStageMentions(
  text: string
): Array<{ stage: TopicProbeComputeStage; index: number }> {
  const mentions: Array<{
    stage: TopicProbeComputeStage;
    index: number;
  }> = [];
  const patterns: Array<[TopicProbeComputeStage, RegExp]> = [
    [
      "bounded_probe",
      /\bbounded(?:[-\s]+feasibility)?[-\s]+probe\b|\bprobe[-\s]+stage\b/giu
    ],
    [
      "confirmatory",
      /\bconfirmatory(?:[-\s]+(?:study|run|profile|stage|execution))?\b/giu
    ]
  ];
  for (const [stage, pattern] of patterns) {
    for (const match of text.matchAll(pattern)) {
      mentions.push({ stage, index: match.index ?? -1 });
    }
  }
  return mentions.sort((left, right) => left.index - right.index);
}

function nearestPrecedingStage(
  mentions: Array<{ stage: TopicProbeComputeStage; index: number }>,
  valueIndex: number
): TopicProbeComputeStage | undefined {
  const preceding = mentions.filter((mention) => mention.index < valueIndex);
  const nearest = preceding[preceding.length - 1];
  if (!nearest || valueIndex - nearest.index > 240) {
    return undefined;
  }
  return nearest.stage;
}

function resolveStageLimit(
  stage: TopicProbeComputeStage,
  values: { gpuHours: number[]; maxGpus: number[]; maxTrials: number[] }
): TopicProbeComputeStageLimit {
  const gpuHoursValues = uniqueNumbers(values.gpuHours);
  const maxGpuValues = uniqueNumbers(values.maxGpus);
  const maxTrialValues = uniqueNumbers(values.maxTrials);
  if (gpuHoursValues.length === 0) {
    throw new Error(
      `topic_probe_compute_budget_${stage}_max_gpu_hours_missing`
    );
  }
  if (gpuHoursValues.length > 1) {
    throw new Error(
      `topic_probe_compute_budget_${stage}_max_gpu_hours_conflict`
    );
  }
  if (maxGpuValues.length === 0) {
    throw new Error(
      `topic_probe_compute_budget_${stage}_max_concurrent_gpus_missing`
    );
  }
  if (maxGpuValues.length > 1) {
    throw new Error(
      `topic_probe_compute_budget_${stage}_max_concurrent_gpus_conflict`
    );
  }
  if (maxTrialValues.length === 0) {
    throw new Error(
      `topic_probe_compute_budget_${stage}_max_trials_missing`
    );
  }
  if (maxTrialValues.length > 1) {
    throw new Error(
      `topic_probe_compute_budget_${stage}_max_trials_conflict`
    );
  }
  const maxGpuHours = gpuHoursValues[0];
  const maxConcurrentGpus = maxGpuValues[0];
  const maxTrials = maxTrialValues[0];
  if (!isPositiveFinite(maxGpuHours)) {
    throw new Error(
      `topic_probe_compute_budget_${stage}_max_gpu_hours_invalid`
    );
  }
  if (!isPositiveInteger(maxConcurrentGpus)) {
    throw new Error(
      `topic_probe_compute_budget_${stage}_max_concurrent_gpus_invalid`
    );
  }
  if (!isPositiveInteger(maxTrials)) {
    throw new Error(
      `topic_probe_compute_budget_${stage}_max_trials_invalid`
    );
  }
  return {
    max_gpu_hours: maxGpuHours,
    max_concurrent_gpus: maxConcurrentGpus,
    max_trials: maxTrials
  };
}

function isTopicProbeComputeBudgetContract(
  value: unknown
): value is TopicProbeComputeBudgetContract {
  if (!isRecord(value)) {
    return false;
  }
  const fields = new Set([
    "schema_version",
    "artifact_kind",
    "generated_at",
    "run_id",
    "stage",
    "active_topic_probe_contract_sha256",
    "local_budget_sha256",
    "brief_compute_budget_ceiling",
    "limits",
    "active_limit",
    "content_sha256"
  ]);
  return (
    hasOnlyKnownFields(value, fields)
    && value.schema_version === 1
    && value.artifact_kind === "topic_probe_compute_budget_contract"
    && hasText(value.generated_at)
    && hasText(value.run_id)
    && STAGE_NAMES.includes(value.stage as TopicProbeComputeStage)
    && isSha256(value.active_topic_probe_contract_sha256)
    && isSha256(value.local_budget_sha256)
    && isTopicProbeComputeBudgetLimits(value.brief_compute_budget_ceiling)
    && isTopicProbeComputeBudgetLimits(value.limits)
    && isStageLimit(value.active_limit)
    && isSha256(value.content_sha256)
  );
}

function isStageLimit(value: unknown): value is TopicProbeComputeStageLimit {
  if (!isRecord(value) || !hasOnlyKnownFields(value, BUDGET_LIMIT_FIELDS)) {
    return false;
  }
  return (
    isPositiveFinite(value.max_gpu_hours)
    && isPositiveInteger(value.max_concurrent_gpus)
    && isPositiveInteger(value.max_trials)
  );
}

function isLedgerEntry(
  value: unknown
): value is TopicProbeComputeUsageLedgerEntry {
  if (
    !isRecord(value)
    || value.schema_version !== 1
    || value.artifact_kind
      !== "topic_probe_compute_usage_ledger_entry"
    || !hasText(value.run_id)
    || !STAGE_NAMES.includes(value.stage as TopicProbeComputeStage)
    || !isSha256(value.budget_contract_sha256)
    || !isPositiveInteger(value.sequence)
    || !(
      value.previous_entry_sha256 === null
      || isSha256(value.previous_entry_sha256)
    )
    || !isPositiveInteger(value.attempt)
    || !hasText(value.profile)
    || !isSha256(value.command_sha256)
    || !hasText(value.recorded_at)
    || !isSha256(value.content_sha256)
  ) {
    return false;
  }
  if (value.event_kind === "preflight_estimate") {
    return (
      isNonNegativeFinite(value.estimated_wall_time_ms)
      && isNonNegativeInteger(value.estimated_gpu_count)
      && isNonNegativeFinite(value.estimated_gpu_hours)
      && isNonNegativeInteger(value.estimated_fresh_trials)
      && isNonNegativeFinite(value.prior_actual_gpu_hours)
      && isNonNegativeInteger(value.prior_fresh_executed_trials)
      && isNonNegativeFinite(value.projected_gpu_hours)
      && isNonNegativeInteger(value.projected_fresh_executed_trials)
      && (value.decision === "allowed" || value.decision === "rejected")
      && isStringArray(value.reason_codes)
    );
  }
  if (value.event_kind === "actual_usage") {
    return (
      hasText(value.started_at)
      && hasText(value.finished_at)
      && isNonNegativeFinite(value.wall_time_ms)
      && isExecutionKind(value.execution_kind)
      && isNonNegativeInteger(value.actual_gpu_count)
      && isNonNegativeFinite(value.gpu_hours)
      && isNonNegativeInteger(value.fresh_executed_trials)
      && isNonNegativeInteger(value.cached_trials)
      && isUsageEvidenceKindConsistent({
        execution_kind: value.execution_kind,
        actual_gpu_count: value.actual_gpu_count,
        fresh_executed_trials: value.fresh_executed_trials,
        cached_trials: value.cached_trials
      })
      && isSha256(value.usage_evidence_sha256)
      && isNonNegativeFinite(value.cumulative_gpu_hours)
      && isNonNegativeInteger(value.cumulative_fresh_executed_trials)
      && typeof value.within_budget === "boolean"
      && isStringArray(value.reason_codes)
    );
  }
  return (
    value.event_kind === "usage_unverifiable"
    && hasText(value.started_at)
    && hasText(value.finished_at)
    && isNonNegativeFinite(value.wall_time_ms)
    && isStringArray(value.reason_codes)
    && value.reason_codes.length > 0
  );
}

function evaluateProjectedBudget(
  limit: TopicProbeComputeStageLimit,
  projectedGpuHours: number,
  estimatedGpuCount: number,
  projectedFreshTrials: number
): string[] {
  const reasons: string[] = [];
  if (estimatedGpuCount > limit.max_concurrent_gpus) {
    reasons.push(
      "topic_probe_compute_preflight_max_concurrent_gpus_exceeded"
    );
  }
  if (projectedGpuHours > limit.max_gpu_hours) {
    reasons.push(
      "topic_probe_compute_preflight_max_gpu_hours_exceeded"
    );
  }
  if (projectedFreshTrials > limit.max_trials) {
    reasons.push(
      "topic_probe_compute_preflight_max_trials_exceeded"
    );
  }
  return reasons;
}

function evaluateActualBudget(
  limit: TopicProbeComputeStageLimit,
  cumulativeGpuHours: number,
  actualGpuCount: number,
  cumulativeFreshTrials: number,
  reservedGpuCount?: number
): string[] {
  const reasons: string[] = [];
  if (
    reservedGpuCount !== undefined
    && actualGpuCount > reservedGpuCount
  ) {
    reasons.push(
      "topic_probe_compute_actual_gpu_count_exceeds_preflight_reservation"
    );
  }
  if (actualGpuCount > limit.max_concurrent_gpus) {
    reasons.push(
      "topic_probe_compute_actual_max_concurrent_gpus_exceeded"
    );
  }
  if (cumulativeGpuHours > limit.max_gpu_hours) {
    reasons.push(
      "topic_probe_compute_actual_max_gpu_hours_exceeded"
    );
  }
  if (cumulativeFreshTrials > limit.max_trials) {
    reasons.push(
      "topic_probe_compute_actual_max_trials_exceeded"
    );
  }
  return reasons;
}

function buildLedgerBase(input: {
  contract: TopicProbeComputeBudgetContract;
  validation: TopicProbeComputeUsageLedgerValidation;
  attempt: number;
  profile: string;
  command: string;
  recordedAt?: string;
}): Omit<TopicProbeComputeLedgerEntryBase, "content_sha256"> {
  if (!hasText(input.profile)) {
    throw new Error("topic_probe_compute_ledger_profile_missing");
  }
  if (!hasText(input.command)) {
    throw new Error("topic_probe_compute_ledger_command_missing");
  }
  return {
    schema_version: 1,
    artifact_kind: "topic_probe_compute_usage_ledger_entry",
    run_id: input.contract.run_id,
    stage: input.contract.stage,
    budget_contract_sha256: input.contract.content_sha256,
    sequence: input.validation.nextSequence,
    previous_entry_sha256: input.validation.previousEntrySha256,
    attempt: input.attempt,
    profile: input.profile.trim(),
    command_sha256: sha256Utf8(input.command),
    recorded_at: input.recordedAt || new Date().toISOString()
  };
}

function withContentHash<T extends object>(
  payload: T
): T & { content_sha256: string } {
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

function requirePendingAttempt(
  validation: TopicProbeComputeUsageLedgerValidation,
  profile: string,
  command: string
): TopicProbeComputePreflightEntry {
  if (!validation.valid) {
    throw new Error(
      `topic_probe_compute_usage_ledger_invalid:${validation.reasons.join(",")}`
    );
  }
  if (validation.blocked) {
    throw new Error("topic_probe_compute_usage_ledger_terminally_blocked");
  }
  if (validation.pendingAttempt === undefined) {
    throw new Error(
      "topic_probe_compute_usage_ledger_preflight_missing"
    );
  }
  if (!hasText(profile)) {
    throw new Error("topic_probe_compute_ledger_profile_missing");
  }
  if (!hasText(command)) {
    throw new Error("topic_probe_compute_ledger_command_missing");
  }
  const pendingPreflight = validation.entries
    .slice()
    .reverse()
    .find((entry): entry is TopicProbeComputePreflightEntry =>
      entry.event_kind === "preflight_estimate"
      && entry.decision === "allowed"
      && entry.attempt === validation.pendingAttempt
    );
  if (
    !pendingPreflight
    || pendingPreflight.profile !== profile.trim()
    || pendingPreflight.command_sha256 !== sha256Utf8(command)
  ) {
    throw new Error(
      "topic_probe_compute_usage_ledger_pending_binding_mismatch"
    );
  }
  return pendingPreflight;
}

function ledgerAppendReadinessReasons(
  validation: TopicProbeComputeUsageLedgerValidation
): string[] {
  const reasons = [...validation.reasons];
  if (validation.pendingAttempt !== undefined) {
    reasons.push(
      "topic_probe_compute_usage_ledger_pending_attempt_unresolved"
    );
  }
  if (validation.blocked) {
    reasons.push(
      "topic_probe_compute_usage_ledger_terminally_blocked"
    );
  }
  return uniqueStrings(reasons);
}

async function withTopicProbeComputeLedgerLock<T>(
  ledgerPath: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = path.resolve(ledgerPath);
  const previousProcessLock = PROCESS_LEDGER_LOCKS.get(key);
  let releaseProcessLock!: () => void;
  const processLock = new Promise<void>((resolve) => {
    releaseProcessLock = resolve;
  });
  PROCESS_LEDGER_LOCKS.set(key, processLock);

  if (previousProcessLock) {
    await previousProcessLock;
  }

  let releaseFileLock: (() => Promise<void>) | undefined;
  try {
    releaseFileLock = await acquireLedgerFileLock(key);
    return await operation();
  } finally {
    try {
      if (releaseFileLock) {
        await releaseFileLock();
      }
    } finally {
      releaseProcessLock();
      if (PROCESS_LEDGER_LOCKS.get(key) === processLock) {
        PROCESS_LEDGER_LOCKS.delete(key);
      }
    }
  }
}

async function acquireLedgerFileLock(
  ledgerPath: string
): Promise<() => Promise<void>> {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  const lockPath = `${ledgerPath}${LEDGER_FILE_LOCK_SUFFIX}`;
  const startedAt = performance.now();
  let retryDelayMs = LEDGER_LOCK_INITIAL_RETRY_MS;
  let retryAttempts = 0;

  while (true) {
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if (readErrorCode(error) !== "EEXIST") {
        throw error;
      }
      const elapsedMs = performance.now() - startedAt;
      if (
        elapsedMs >= LEDGER_LOCK_ACQUIRE_TIMEOUT_MS
        || retryAttempts >= LEDGER_LOCK_MAX_RETRY_ATTEMPTS
      ) {
        throw new Error("topic_probe_compute_usage_ledger_lock_timeout");
      }
      retryAttempts += 1;
      if (await recoverStaleLedgerFileLock(lockPath)) {
        continue;
      }
      const remainingMs = LEDGER_LOCK_ACQUIRE_TIMEOUT_MS
        - elapsedMs;
      if (remainingMs <= 0) {
        throw new Error("topic_probe_compute_usage_ledger_lock_timeout");
      }
      await waitForLedgerLock(Math.min(retryDelayMs, remainingMs));
      retryDelayMs = Math.min(
        retryDelayMs * 2,
        LEDGER_LOCK_MAX_RETRY_MS
      );
      continue;
    }

    const token = randomUUID();
    try {
      await handle.writeFile(
        `${JSON.stringify({
          pid: process.pid,
          token,
          acquired_at: new Date().toISOString()
        })}\n`,
        "utf8"
      );
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlinkIfPresent(lockPath);
      throw error;
    }
    await handle.close();
    return () => releaseLedgerFileLock(lockPath, token);
  }
}

async function recoverStaleLedgerFileLock(
  lockPath: string
): Promise<boolean> {
  let lockStats: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    lockStats = await fs.lstat(lockPath);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") {
      return true;
    }
    throw error;
  }
  if (Date.now() - lockStats.mtimeMs < LEDGER_LOCK_STALE_AFTER_MS) {
    return false;
  }

  const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    await fs.rename(lockPath, stalePath);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") {
      return true;
    }
    throw error;
  }
  await unlinkIfPresent(stalePath);
  return true;
}

async function releaseLedgerFileLock(
  lockPath: string,
  token: string
): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, "utf8");
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }

  let owner: unknown;
  try {
    owner = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isRecord(owner) || owner.token !== token) {
    return;
  }
  await unlinkIfPresent(lockPath);
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

async function waitForLedgerLock(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function readLedger(ledgerPath: string): Promise<string> {
  try {
    return await fs.readFile(ledgerPath, "utf8");
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function appendLedgerLine(
  ledgerPath: string,
  entry: TopicProbeComputeUsageLedgerEntry
): Promise<void> {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  const handle = await fs.open(ledgerPath, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function readErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : undefined;
}

function gpuHours(wallTimeMs: number, gpuCount: number): number {
  return normalizeGpuHours(
    (wallTimeMs * gpuCount) / 3_600_000
  );
}

function sumGpuHours(left: number, right: number): number {
  return normalizeGpuHours(left + right);
}

function normalizeGpuHours(value: number): number {
  return Number(value.toFixed(12));
}

function cloneBudgetLimits(
  value: TopicProbeComputeBudgetLimits
): TopicProbeComputeBudgetLimits {
  return {
    bounded_probe: { ...value.bounded_probe },
    confirmatory: { ...value.confirmatory }
  };
}

function parseNumberToken(value: string): number {
  const normalized = value.trim().toLowerCase();
  const word = NUMBER_WORDS.get(normalized);
  const parsed = word ?? Number(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error("topic_probe_compute_budget_number_invalid");
  }
  return parsed;
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

function isUsageEvidenceKindConsistent(value: {
  execution_kind: TopicProbeComputeExecutionKind;
  actual_gpu_count: number;
  fresh_executed_trials: number;
  cached_trials: number;
}): boolean {
  return (
    (
      value.execution_kind === "gpu_execution"
      && value.actual_gpu_count > 0
      && value.fresh_executed_trials > 0
    )
    || (
      value.execution_kind === "cpu_execution"
      && value.actual_gpu_count === 0
      && value.fresh_executed_trials > 0
    )
    || (
      value.execution_kind === "cache_hit"
      && value.actual_gpu_count === 0
      && value.fresh_executed_trials === 0
      && value.cached_trials > 0
    )
  );
}

function isExecutionKind(
  value: unknown
): value is TopicProbeComputeExecutionKind {
  return (
    value === "gpu_execution"
    || value === "cpu_execution"
    || value === "cache_hit"
  );
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isPositiveFinite(value: unknown): value is number {
  return (
    typeof value === "number"
    && Number.isFinite(value)
    && value > 0
  );
}

function isNonNegativeFinite(value: unknown): value is number {
  return (
    typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKnownFields(
  value: Record<string, unknown>,
  fields: ReadonlySet<string>
): boolean {
  return Object.keys(value).every((key) => fields.has(key));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length
    && left.every((value, index) => value === right[index])
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
