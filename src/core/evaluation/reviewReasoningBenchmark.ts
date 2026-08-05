import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { parseStructuredModelJsonObject } from "../analysis/modelJson.js";
import { hashCanonical } from "../canonicalHash.js";
import type { LLMClient, LLMCompletionProvenance, LLMCompletionUsage } from "../llm/client.js";

export const REVIEW_REASONING_BENCHMARK_VERSION = "1.0";
export const REVIEW_REASONING_BENCHMARK_EFFORTS = ["high", "xhigh", "max"] as const;

export type ReviewReasoningBenchmarkEffort = typeof REVIEW_REASONING_BENCHMARK_EFFORTS[number];
export type ReviewReasoningBenchmarkSplit = "development" | "test";

export type ReviewReasoningFaultId =
  | "comparison_reference_missing"
  | "independent_unit_floor_breached"
  | "repetition_contract_unsatisfied"
  | "uncertainty_omitted"
  | "claim_scope_overreach"
  | "partition_overlap"
  | "metric_direction_reversed"
  | "comparison_budget_confounded"
  | "evidence_binding_mismatch"
  | "citation_support_unverified";

type ClaimScope = "local" | "bounded_transfer" | "universal";
type MetricDirection = "maximize" | "minimize";

export interface ReviewReasoningBenchmarkPacket {
  case_id: string;
  source_fingerprint: string;
  split: ReviewReasoningBenchmarkSplit;
  comparison: {
    required: boolean;
    reference_declared: boolean;
    subject_budget_units: number;
    reference_budget_units: number;
    causal_comparison_claimed: boolean;
  };
  evaluation: {
    independent_units: number;
    minimum_independent_units: number;
    repetitions: number;
    minimum_repetitions: number;
    uncertainty_required: boolean;
    uncertainty_reported: boolean;
  };
  claims: {
    declared_scope: ClaimScope;
    evidence_ceiling: ClaimScope;
  };
  partitions: {
    development_fingerprints: string[];
    evaluation_fingerprints: string[];
  };
  metric: {
    name: string;
    declared_direction: MetricDirection;
    contract_direction: MetricDirection;
  };
  evidence_binding: {
    claimed_sha256: string;
    observed_sha256: string;
  };
  citation_support: {
    external_claim_present: boolean;
    full_text_verified: boolean;
  };
}

export interface ReviewReasoningBenchmarkCase {
  case_id: string;
  source_fingerprint: string;
  split: ReviewReasoningBenchmarkSplit;
  injected_fault_ids: ReviewReasoningFaultId[];
  packet: ReviewReasoningBenchmarkPacket;
}

export interface ReviewReasoningAdjudicationCase {
  adjudication_id: string;
  case_id: string;
  candidate_findings: Array<{
    finding_id: string;
    fault_id: ReviewReasoningFaultId;
    reviewer_role: string;
  }>;
  expected_adopted_finding_ids: string[];
}

export interface ReviewReasoningBenchmarkSuite {
  schema_version: typeof REVIEW_REASONING_BENCHMARK_VERSION;
  artifact_type: "ReviewReasoningBenchmarkSuite";
  evaluation_regime: "controlled_deterministic_fault_injection";
  claim_ceiling: "registered_fault_families_only";
  external_validation: "not_run";
  registry: Array<{
    fault_id: ReviewReasoningFaultId;
    split: ReviewReasoningBenchmarkSplit;
    severity: "blocker" | "warning";
    target_node: "design_experiments" | "run_experiments" | "analyze_results" | "review";
  }>;
  cases: ReviewReasoningBenchmarkCase[];
  adjudication_cases: ReviewReasoningAdjudicationCase[];
}

export interface ReviewReasoningCasePrediction {
  case_id: string;
  findings: Array<{
    fault_id: string;
    severity: "blocker" | "warning";
  }>;
}

export interface ReviewReasoningBenchmarkResponse {
  case_reviews: ReviewReasoningCasePrediction[];
  adjudications: Array<{
    adjudication_id: string;
    adopt_finding_ids: string[];
  }>;
}

export interface ReviewReasoningBenchmarkScore {
  gold_fault_count: number;
  predicted_fault_count: number;
  true_positive_count: number;
  false_positive_count: number;
  false_negative_count: number;
  defect_recall: number;
  defect_precision: number;
  clean_case_specificity: number;
  exact_case_accuracy: number;
  adjudication_accuracy: number;
  adjudication_exact_accuracy: number;
}

export interface ReviewReasoningBenchmarkObservation {
  observation_id: string;
  repetition: number;
  effort: ReviewReasoningBenchmarkEffort;
  input_sha256: string;
  output_sha256: string | null;
  raw_response_sha256: string | null;
  response_repaired: boolean;
  status: "completed" | "failed";
  error?: string;
  latency_ms: number;
  usage?: LLMCompletionUsage;
  provenance?: LLMCompletionProvenance;
  score?: ReviewReasoningBenchmarkScore;
  case_outcomes?: Record<string, { recall: number; precision: number; exact: number }>;
  adjudication_outcomes?: Record<string, { accuracy: number; exact: number }>;
  raw_response: string;
}

export interface ReviewReasoningBenchmarkAggregate {
  effort: ReviewReasoningBenchmarkEffort;
  completed_repetitions: number;
  failed_repetitions: number;
  mean_defect_recall: number | null;
  mean_defect_precision: number | null;
  mean_clean_case_specificity: number | null;
  mean_exact_case_accuracy: number | null;
  mean_adjudication_accuracy: number | null;
  mean_adjudication_exact_accuracy: number | null;
  mean_latency_ms: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
}

export interface ReviewReasoningPromotionDecision {
  comparison: "xhigh_over_high" | "max_over_xhigh";
  status: "eligible" | "blocked" | "not_evaluated";
  candidate_effort: ReviewReasoningBenchmarkEffort;
  reference_effort: ReviewReasoningBenchmarkEffort;
  reasons: string[];
  observed_recall_delta: number | null;
  recall_delta_ci95: [number, number] | null;
  observed_precision_delta: number | null;
  observed_adjudication_delta: number | null;
}

export interface ReviewReasoningBenchmarkReport {
  schema_version: typeof REVIEW_REASONING_BENCHMARK_VERSION;
  artifact_type: "ReviewReasoningBenchmarkReport";
  generated_at: string;
  evaluation_regime: "controlled_deterministic_fault_injection";
  claim_ceiling: "registered_fault_families_only";
  policy_scope: "internal_model_routing_only";
  suite_sha256: string;
  split: ReviewReasoningBenchmarkSplit;
  provider: string;
  requested_model: string;
  repetitions: number;
  efforts: ReviewReasoningBenchmarkEffort[];
  suite_validation: ReviewReasoningSuiteValidation;
  observations: ReviewReasoningBenchmarkObservation[];
  aggregates: ReviewReasoningBenchmarkAggregate[];
  promotion_decisions: ReviewReasoningPromotionDecision[];
  diagnostics: {
    ceiling_effect_detected: boolean;
    reasoning_tier_separation_observed: boolean;
    next_action: string;
  };
  routing_policy_review_allowed: boolean;
  automatic_policy_change_allowed: false;
}

export interface ReviewReasoningSuiteValidation {
  valid: boolean;
  errors: string[];
  case_count: number;
  clean_case_count: number;
  fault_family_count: number;
  source_disjoint: boolean;
  fault_family_disjoint: boolean;
  oracle_replay_passed: boolean;
}

export interface RunReviewReasoningBenchmarkOptions {
  llm: LLMClient;
  provider: string;
  model: string;
  efforts: ReviewReasoningBenchmarkEffort[];
  repetitions: number;
  split?: ReviewReasoningBenchmarkSplit;
  suite?: ReviewReasoningBenchmarkSuite;
  now?: () => Date;
  onObservation?: (observation: ReviewReasoningBenchmarkObservation) => Promise<void> | void;
}

const FAULT_REGISTRY: ReviewReasoningBenchmarkSuite["registry"] = [
  { fault_id: "comparison_reference_missing", split: "development", severity: "blocker", target_node: "design_experiments" },
  { fault_id: "independent_unit_floor_breached", split: "development", severity: "blocker", target_node: "design_experiments" },
  { fault_id: "repetition_contract_unsatisfied", split: "development", severity: "blocker", target_node: "run_experiments" },
  { fault_id: "uncertainty_omitted", split: "development", severity: "warning", target_node: "analyze_results" },
  { fault_id: "claim_scope_overreach", split: "development", severity: "blocker", target_node: "review" },
  { fault_id: "partition_overlap", split: "test", severity: "blocker", target_node: "design_experiments" },
  { fault_id: "metric_direction_reversed", split: "test", severity: "blocker", target_node: "analyze_results" },
  { fault_id: "comparison_budget_confounded", split: "test", severity: "blocker", target_node: "design_experiments" },
  { fault_id: "evidence_binding_mismatch", split: "test", severity: "blocker", target_node: "review" },
  { fault_id: "citation_support_unverified", split: "test", severity: "warning", target_node: "review" }
];

const CLAIM_SCOPE_ORDER: Record<ClaimScope, number> = {
  local: 0,
  bounded_transfer: 1,
  universal: 2
};

export function createReviewReasoningBenchmarkSuiteV1(): ReviewReasoningBenchmarkSuite {
  const cases: ReviewReasoningBenchmarkCase[] = [];
  let caseIndex = 1;
  for (const entry of FAULT_REGISTRY) {
    for (let ordinal = 0; ordinal < 3; ordinal += 1) {
      cases.push(createMutatedCase(caseIndex, entry.split, [entry.fault_id], ordinal));
      caseIndex += 1;
    }
  }
  for (let ordinal = 0; ordinal < 3; ordinal += 1) {
    cases.push(createMutatedCase(caseIndex, "development", [], ordinal, true));
    caseIndex += 1;
  }
  for (let ordinal = 0; ordinal < 5; ordinal += 1) {
    cases.push(createMutatedCase(caseIndex, "test", [], ordinal, true));
    caseIndex += 1;
  }
  const testFaults = FAULT_REGISTRY
    .filter((entry) => entry.split === "test")
    .map((entry) => entry.fault_id);
  for (let ordinal = 0; ordinal < 10; ordinal += 1) {
    const injected = [testFaults[ordinal % testFaults.length], testFaults[(ordinal + 2) % testFaults.length]];
    if (ordinal % 3 === 0) injected.push(testFaults[(ordinal + 4) % testFaults.length]);
    cases.push(createMutatedCase(caseIndex, "test", [...new Set(injected)], ordinal));
    caseIndex += 1;
  }

  const testCases = cases.filter((item) => item.split === "test");
  const adjudicationTargets = [
    ...testCases.filter((item) => item.injected_fault_ids.length > 1).slice(0, 4),
    ...testCases.filter((item) => item.injected_fault_ids.length === 1).slice(0, 2),
    ...testCases.filter((item) => item.injected_fault_ids.length === 0).slice(0, 2)
  ];
  const adjudicationCases = adjudicationTargets.map((item, index) =>
    createAdjudicationCase(item, index)
  );

  return {
    schema_version: REVIEW_REASONING_BENCHMARK_VERSION,
    artifact_type: "ReviewReasoningBenchmarkSuite",
    evaluation_regime: "controlled_deterministic_fault_injection",
    claim_ceiling: "registered_fault_families_only",
    external_validation: "not_run",
    registry: FAULT_REGISTRY.map((item) => ({ ...item })),
    cases,
    adjudication_cases: adjudicationCases
  };
}

export function deriveReviewReasoningFaults(
  packet: ReviewReasoningBenchmarkPacket
): ReviewReasoningFaultId[] {
  const faults: ReviewReasoningFaultId[] = [];
  if (packet.comparison.required && !packet.comparison.reference_declared) {
    faults.push("comparison_reference_missing");
  }
  if (packet.evaluation.independent_units < packet.evaluation.minimum_independent_units) {
    faults.push("independent_unit_floor_breached");
  }
  if (packet.evaluation.repetitions < packet.evaluation.minimum_repetitions) {
    faults.push("repetition_contract_unsatisfied");
  }
  if (packet.evaluation.uncertainty_required && !packet.evaluation.uncertainty_reported) {
    faults.push("uncertainty_omitted");
  }
  if (CLAIM_SCOPE_ORDER[packet.claims.declared_scope] > CLAIM_SCOPE_ORDER[packet.claims.evidence_ceiling]) {
    faults.push("claim_scope_overreach");
  }
  if (packet.partitions.development_fingerprints.some((item) => packet.partitions.evaluation_fingerprints.includes(item))) {
    faults.push("partition_overlap");
  }
  if (packet.metric.declared_direction !== packet.metric.contract_direction) {
    faults.push("metric_direction_reversed");
  }
  if (
    packet.comparison.causal_comparison_claimed
    && packet.comparison.subject_budget_units !== packet.comparison.reference_budget_units
  ) {
    faults.push("comparison_budget_confounded");
  }
  if (packet.evidence_binding.claimed_sha256 !== packet.evidence_binding.observed_sha256) {
    faults.push("evidence_binding_mismatch");
  }
  if (packet.citation_support.external_claim_present && !packet.citation_support.full_text_verified) {
    faults.push("citation_support_unverified");
  }
  return faults;
}

export function validateReviewReasoningBenchmarkSuite(
  suite: ReviewReasoningBenchmarkSuite
): ReviewReasoningSuiteValidation {
  const errors: string[] = [];
  const caseIds = new Set<string>();
  const sourceBySplit = new Map<ReviewReasoningBenchmarkSplit, Set<string>>([
    ["development", new Set()],
    ["test", new Set()]
  ]);
  const registryFaultsBySplit = new Map<ReviewReasoningBenchmarkSplit, Set<string>>([
    ["development", new Set()],
    ["test", new Set()]
  ]);
  for (const entry of suite.registry) {
    registryFaultsBySplit.get(entry.split)?.add(entry.fault_id);
  }
  let oracleReplayPassed = true;
  for (const item of suite.cases) {
    if (caseIds.has(item.case_id)) {
      errors.push(`Duplicate case_id: ${item.case_id}`);
    }
    caseIds.add(item.case_id);
    sourceBySplit.get(item.split)?.add(item.source_fingerprint);
    const replayed = deriveReviewReasoningFaults(item.packet).sort();
    const declared = [...item.injected_fault_ids].sort();
    if (JSON.stringify(replayed) !== JSON.stringify(declared)) {
      oracleReplayPassed = false;
      errors.push(`Oracle replay mismatch for ${item.case_id}.`);
    }
    for (const faultId of declared) {
      if (!registryFaultsBySplit.get(item.split)?.has(faultId)) {
        errors.push(`Fault ${faultId} is not registered for ${item.split}.`);
      }
    }
  }
  const developmentSources = sourceBySplit.get("development") || new Set<string>();
  const testSources = sourceBySplit.get("test") || new Set<string>();
  const sourceDisjoint = [...developmentSources].every((item) => !testSources.has(item));
  if (!sourceDisjoint) errors.push("Development and test source fingerprints overlap.");
  const developmentFaults = registryFaultsBySplit.get("development") || new Set<string>();
  const testFaults = registryFaultsBySplit.get("test") || new Set<string>();
  const faultFamilyDisjoint = [...developmentFaults].every((item) => !testFaults.has(item));
  if (!faultFamilyDisjoint) errors.push("Development and test fault families overlap.");

  const adjudicationIds = new Set<string>();
  for (const item of suite.adjudication_cases) {
    if (adjudicationIds.has(item.adjudication_id)) {
      errors.push(`Duplicate adjudication_id: ${item.adjudication_id}`);
    }
    adjudicationIds.add(item.adjudication_id);
    if (!caseIds.has(item.case_id)) errors.push(`Unknown adjudication case: ${item.case_id}`);
    const findingIds = new Set(item.candidate_findings.map((finding) => finding.finding_id));
    for (const expected of item.expected_adopted_finding_ids) {
      if (!findingIds.has(expected)) errors.push(`Unknown expected finding: ${expected}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    case_count: suite.cases.length,
    clean_case_count: suite.cases.filter((item) => item.injected_fault_ids.length === 0).length,
    fault_family_count: suite.registry.length,
    source_disjoint: sourceDisjoint,
    fault_family_disjoint: faultFamilyDisjoint,
    oracle_replay_passed: oracleReplayPassed
  };
}

export function buildReviewReasoningBenchmarkPrompt(input: {
  suite: ReviewReasoningBenchmarkSuite;
  split: ReviewReasoningBenchmarkSplit;
  repetition: number;
}): { systemPrompt: string; userPrompt: string; inputSha256: string } {
  const cases = rotate(
    input.suite.cases.filter((item) => item.split === input.split),
    input.repetition
  );
  const visibleCaseIds = new Set(cases.map((item) => item.case_id));
  const adjudications = rotate(
    input.suite.adjudication_cases.filter((item) => visibleCaseIds.has(item.case_id)),
    input.repetition
  );
  const registry = input.suite.registry.map((item) => ({
    fault_id: item.fault_id,
    severity: item.severity,
    target_node: item.target_node
  }));
  const systemPrompt = [
    "You are an isolated research-quality reviewer in a controlled benchmark.",
    "Use only the packets and finding candidates included in the prompt.",
    "Do not browse, use tools, infer hidden benchmark labels, or add fault identifiers outside the supplied registry.",
    "Return exactly one JSON object and no prose."
  ].join(" ");
  const userPrompt = [
    "Review each packet for every supported registered fault. A clean packet must have an empty findings array.",
    "For adjudication items, adopt only candidate findings directly supported by the linked packet.",
    "Output schema:",
    '{"case_reviews":[{"case_id":"...","findings":[{"fault_id":"...","severity":"blocker|warning"}]}],"adjudications":[{"adjudication_id":"...","adopt_finding_ids":["..."]}]}',
    "Registered faults:",
    JSON.stringify(registry),
    "Packets:",
    JSON.stringify(cases.map((item) => ({ case_id: item.case_id, review_packet: renderReviewPacket(item.packet) }))),
    "Adjudication items:",
    JSON.stringify(adjudications.map((item) => ({
      adjudication_id: item.adjudication_id,
      case_id: item.case_id,
      candidate_findings: item.candidate_findings
    })))
  ].join("\n");
  return {
    systemPrompt,
    userPrompt,
    inputSha256: hashCanonical({ systemPrompt, userPrompt })
  };
}

export function parseReviewReasoningBenchmarkResponse(
  raw: string,
  suite: ReviewReasoningBenchmarkSuite,
  split: ReviewReasoningBenchmarkSplit
): { response: ReviewReasoningBenchmarkResponse; repaired: boolean } {
  const parsed = parseStructuredModelJsonObject<ReviewReasoningBenchmarkResponse>(raw, {
    emptyError: "Review benchmark response was empty.",
    notFoundError: "Review benchmark response did not contain a JSON object.",
    incompleteError: "Review benchmark response contained incomplete JSON.",
    invalidError: "Review benchmark response contained invalid JSON."
  });
  if (!Array.isArray(parsed.value.case_reviews) || !Array.isArray(parsed.value.adjudications)) {
    throw new Error("Review benchmark response must contain case_reviews and adjudications arrays.");
  }
  const validCases = new Set(suite.cases.filter((item) => item.split === split).map((item) => item.case_id));
  const seenCases = new Set<string>();
  for (const item of parsed.value.case_reviews) {
    if (!item || typeof item.case_id !== "string" || !validCases.has(item.case_id) || seenCases.has(item.case_id)) {
      throw new Error(`Invalid or duplicate benchmark case response: ${item?.case_id || "<missing>"}.`);
    }
    seenCases.add(item.case_id);
    if (!Array.isArray(item.findings)) throw new Error(`Findings must be an array for ${item.case_id}.`);
  }
  if (seenCases.size !== validCases.size) {
    throw new Error(`Review benchmark response omitted ${validCases.size - seenCases.size} required case reviews.`);
  }
  const validAdjudications = new Set(
    suite.adjudication_cases
      .filter((item) => validCases.has(item.case_id))
      .map((item) => item.adjudication_id)
  );
  const seenAdjudications = new Set<string>();
  for (const item of parsed.value.adjudications) {
    if (
      !item
      || typeof item.adjudication_id !== "string"
      || !validAdjudications.has(item.adjudication_id)
      || seenAdjudications.has(item.adjudication_id)
      || !Array.isArray(item.adopt_finding_ids)
    ) {
      throw new Error(`Invalid or duplicate benchmark adjudication response: ${item?.adjudication_id || "<missing>"}.`);
    }
    seenAdjudications.add(item.adjudication_id);
  }
  if (seenAdjudications.size !== validAdjudications.size) {
    throw new Error(
      `Review benchmark response omitted ${validAdjudications.size - seenAdjudications.size} required adjudications.`
    );
  }
  return { response: parsed.value, repaired: parsed.repaired };
}

export function scoreReviewReasoningBenchmarkResponse(input: {
  suite: ReviewReasoningBenchmarkSuite;
  split: ReviewReasoningBenchmarkSplit;
  response: ReviewReasoningBenchmarkResponse;
}): {
  score: ReviewReasoningBenchmarkScore;
  caseOutcomes: Record<string, { recall: number; precision: number; exact: number }>;
  adjudicationOutcomes: Record<string, { accuracy: number; exact: number }>;
} {
  const cases = input.suite.cases.filter((item) => item.split === input.split);
  const registry = new Set(input.suite.registry.map((item) => item.fault_id));
  const predictions = new Map(input.response.case_reviews.map((item) => [item.case_id, item]));
  let goldFaultCount = 0;
  let predictedFaultCount = 0;
  let truePositiveCount = 0;
  let falsePositiveCount = 0;
  let cleanCaseCount = 0;
  let cleanCaseCorrect = 0;
  let exactCaseCount = 0;
  const caseOutcomes: Record<string, { recall: number; precision: number; exact: number }> = {};

  for (const item of cases) {
    const gold = new Set(deriveReviewReasoningFaults(item.packet));
    const predicted = new Set(
      (predictions.get(item.case_id)?.findings || [])
        .map((finding) => finding.fault_id)
        .filter((faultId) => registry.has(faultId as ReviewReasoningFaultId))
    );
    const unknownCount = (predictions.get(item.case_id)?.findings || [])
      .filter((finding) => !registry.has(finding.fault_id as ReviewReasoningFaultId)).length;
    const truePositives = [...predicted].filter((faultId) => gold.has(faultId as ReviewReasoningFaultId)).length;
    const falsePositives = [...predicted].filter((faultId) => !gold.has(faultId as ReviewReasoningFaultId)).length + unknownCount;
    goldFaultCount += gold.size;
    predictedFaultCount += predicted.size + unknownCount;
    truePositiveCount += truePositives;
    falsePositiveCount += falsePositives;
    if (gold.size === 0) {
      cleanCaseCount += 1;
      if (predicted.size === 0 && unknownCount === 0) cleanCaseCorrect += 1;
    }
    const exact = setEquals(gold, predicted) && unknownCount === 0 ? 1 : 0;
    exactCaseCount += exact;
    caseOutcomes[item.case_id] = {
      recall: gold.size === 0 ? 1 : truePositives / gold.size,
      precision: predicted.size + unknownCount === 0 ? (gold.size === 0 ? 1 : 0) : truePositives / (predicted.size + unknownCount),
      exact
    };
  }

  const falseNegativeCount = goldFaultCount - truePositiveCount;
  const adjudicationPredictions = new Map(
    input.response.adjudications.map((item) => [item.adjudication_id, item])
  );
  const adjudicationCases = input.suite.adjudication_cases.filter((item) =>
    cases.some((candidate) => candidate.case_id === item.case_id)
  );
  let adjudicationLabelCount = 0;
  let adjudicationLabelCorrect = 0;
  let adjudicationExactCount = 0;
  const adjudicationOutcomes: Record<string, { accuracy: number; exact: number }> = {};
  for (const item of adjudicationCases) {
    const expected = new Set(item.expected_adopted_finding_ids);
    const predicted = new Set(adjudicationPredictions.get(item.adjudication_id)?.adopt_finding_ids || []);
    const candidateIds = item.candidate_findings.map((finding) => finding.finding_id);
    let correct = 0;
    for (const findingId of candidateIds) {
      if (expected.has(findingId) === predicted.has(findingId)) correct += 1;
    }
    adjudicationLabelCount += candidateIds.length;
    adjudicationLabelCorrect += correct;
    const unknownPrediction = [...predicted].some((findingId) => !candidateIds.includes(findingId));
    const exact = setEquals(expected, predicted) && !unknownPrediction ? 1 : 0;
    adjudicationExactCount += exact;
    adjudicationOutcomes[item.adjudication_id] = {
      accuracy: candidateIds.length === 0 ? 1 : correct / candidateIds.length,
      exact
    };
  }

  return {
    score: {
      gold_fault_count: goldFaultCount,
      predicted_fault_count: predictedFaultCount,
      true_positive_count: truePositiveCount,
      false_positive_count: falsePositiveCount,
      false_negative_count: falseNegativeCount,
      defect_recall: goldFaultCount === 0 ? 1 : truePositiveCount / goldFaultCount,
      defect_precision: predictedFaultCount === 0 ? (goldFaultCount === 0 ? 1 : 0) : truePositiveCount / predictedFaultCount,
      clean_case_specificity: cleanCaseCount === 0 ? 1 : cleanCaseCorrect / cleanCaseCount,
      exact_case_accuracy: cases.length === 0 ? 0 : exactCaseCount / cases.length,
      adjudication_accuracy: adjudicationLabelCount === 0 ? 1 : adjudicationLabelCorrect / adjudicationLabelCount,
      adjudication_exact_accuracy: adjudicationCases.length === 0 ? 1 : adjudicationExactCount / adjudicationCases.length
    },
    caseOutcomes,
    adjudicationOutcomes
  };
}

export async function runReviewReasoningBenchmark(
  options: RunReviewReasoningBenchmarkOptions
): Promise<ReviewReasoningBenchmarkReport> {
  const suite = options.suite || createReviewReasoningBenchmarkSuiteV1();
  const split = options.split || "test";
  const suiteValidation = validateReviewReasoningBenchmarkSuite(suite);
  if (!suiteValidation.valid) {
    throw new Error(`Review reasoning benchmark suite is invalid: ${suiteValidation.errors.join(" ")}`);
  }
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1) {
    throw new Error("Review reasoning benchmark repetitions must be a positive integer.");
  }
  if (options.efforts.length === 0 || new Set(options.efforts).size !== options.efforts.length) {
    throw new Error("Review reasoning benchmark efforts must be a non-empty unique list.");
  }

  const observations: ReviewReasoningBenchmarkObservation[] = [];
  for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
    const prompt = buildReviewReasoningBenchmarkPrompt({ suite, split, repetition });
    for (const effort of options.efforts) {
      const started = performance.now();
      let rawResponse = "";
      let observation: ReviewReasoningBenchmarkObservation;
      try {
        const completion = await options.llm.complete(prompt.userPrompt, {
          systemPrompt: prompt.systemPrompt,
          model: options.model,
          reasoningEffort: effort
        });
        rawResponse = completion.text;
        const parsed = parseReviewReasoningBenchmarkResponse(rawResponse, suite, split);
        const scored = scoreReviewReasoningBenchmarkResponse({ suite, split, response: parsed.response });
        observation = {
          observation_id: `rep-${repetition + 1}-${effort}`,
          repetition: repetition + 1,
          effort,
          input_sha256: prompt.inputSha256,
          output_sha256: hashCanonical(parsed.response),
          raw_response_sha256: hashText(rawResponse),
          response_repaired: parsed.repaired,
          status: "completed",
          latency_ms: Math.round(performance.now() - started),
          usage: completion.usage,
          provenance: completion.provenance,
          score: scored.score,
          case_outcomes: scored.caseOutcomes,
          adjudication_outcomes: scored.adjudicationOutcomes,
          raw_response: rawResponse
        };
      } catch (error) {
        observation = {
          observation_id: `rep-${repetition + 1}-${effort}`,
          repetition: repetition + 1,
          effort,
          input_sha256: prompt.inputSha256,
          output_sha256: null,
          raw_response_sha256: rawResponse ? hashCanonical(rawResponse) : null,
          response_repaired: false,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          latency_ms: Math.round(performance.now() - started),
          raw_response: rawResponse
        };
      }
      observations.push(observation);
      await options.onObservation?.(observation);
    }
  }

  const aggregates = options.efforts.map((effort) => aggregateEffort(effort, observations));
  const diagnostics = buildBenchmarkDiagnostics(aggregates);
  const promotionDecisions = [
    buildPromotionDecision("xhigh_over_high", "xhigh", "high", suiteValidation, split, options.repetitions, observations, aggregates),
    buildPromotionDecision("max_over_xhigh", "max", "xhigh", suiteValidation, split, options.repetitions, observations, aggregates)
  ];
  return {
    schema_version: REVIEW_REASONING_BENCHMARK_VERSION,
    artifact_type: "ReviewReasoningBenchmarkReport",
    generated_at: (options.now || (() => new Date()))().toISOString(),
    evaluation_regime: "controlled_deterministic_fault_injection",
    claim_ceiling: "registered_fault_families_only",
    policy_scope: "internal_model_routing_only",
    suite_sha256: hashCanonical(suite),
    split,
    provider: options.provider,
    requested_model: options.model,
    repetitions: options.repetitions,
    efforts: [...options.efforts],
    suite_validation: suiteValidation,
    observations,
    aggregates,
    promotion_decisions: promotionDecisions,
    diagnostics,
    routing_policy_review_allowed: promotionDecisions.some((item) => item.status === "eligible"),
    automatic_policy_change_allowed: false
  };
}

export function renderReviewReasoningBenchmarkMarkdown(report: ReviewReasoningBenchmarkReport): string {
  const lines = [
    "# Review Reasoning Benchmark",
    "",
    `- Generated: ${report.generated_at}`,
    `- Provider/model: ${report.provider} / ${report.requested_model}`,
    `- Split: ${report.split}`,
    `- Repetitions: ${report.repetitions}`,
    `- Suite SHA-256: \`${report.suite_sha256}\``,
    `- Policy scope: ${report.policy_scope}`,
    `- Claim ceiling: ${report.claim_ceiling}`,
    `- Ceiling effect detected: ${report.diagnostics.ceiling_effect_detected}`,
    `- Tier separation observed: ${report.diagnostics.reasoning_tier_separation_observed}`,
    `- Next action: ${report.diagnostics.next_action}`,
    "",
    "## Aggregate",
    "",
    "| Effort | Completed | Recall | Precision | Clean specificity | Adjudication | Latency ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];
  for (const item of report.aggregates) {
    lines.push(
      `| ${item.effort} | ${item.completed_repetitions} | ${formatMetric(item.mean_defect_recall)} | ${formatMetric(item.mean_defect_precision)} | ${formatMetric(item.mean_clean_case_specificity)} | ${formatMetric(item.mean_adjudication_accuracy)} | ${formatMetric(item.mean_latency_ms, 0)} |`
    );
  }
  lines.push("", "## Routing Decisions", "");
  for (const decision of report.promotion_decisions) {
    lines.push(`- **${decision.comparison}: ${decision.status}** - ${decision.reasons.join(" ")}`);
  }
  lines.push(
    "",
    "This report is an internal routing benchmark. It is not external paper evidence and cannot raise a research claim ceiling.",
    ""
  );
  return lines.join("\n");
}

function createMutatedCase(
  caseIndex: number,
  split: ReviewReasoningBenchmarkSplit,
  faultIds: ReviewReasoningFaultId[],
  ordinal: number,
  boundaryClean = false
): ReviewReasoningBenchmarkCase {
  const caseId = `case-${String(caseIndex).padStart(3, "0")}`;
  const sourceFingerprint = hashCanonical({ split, caseIndex, source: `synthetic-record-${caseIndex}` });
  const evidenceHash = hashCanonical({ caseId, artifact: "observed-evidence" });
  const packet: ReviewReasoningBenchmarkPacket = {
    case_id: caseId,
    source_fingerprint: sourceFingerprint,
    split,
    comparison: {
      required: true,
      reference_declared: true,
      subject_budget_units: 100 + ordinal * 10,
      reference_budget_units: 100 + ordinal * 10,
      causal_comparison_claimed: true
    },
    evaluation: {
      independent_units: 48 + ordinal * 8,
      minimum_independent_units: 24,
      repetitions: 3 + ordinal,
      minimum_repetitions: 3,
      uncertainty_required: true,
      uncertainty_reported: true
    },
    claims: {
      declared_scope: "local",
      evidence_ceiling: "local"
    },
    partitions: {
      development_fingerprints: [`dev-${caseIndex}-1`, `dev-${caseIndex}-2`],
      evaluation_fingerprints: [`eval-${caseIndex}-1`, `eval-${caseIndex}-2`]
    },
    metric: {
      name: ordinal % 2 === 0 ? "quality score" : "error rate",
      declared_direction: ordinal % 2 === 0 ? "maximize" : "minimize",
      contract_direction: ordinal % 2 === 0 ? "maximize" : "minimize"
    },
    evidence_binding: {
      claimed_sha256: evidenceHash,
      observed_sha256: evidenceHash
    },
    citation_support: {
      external_claim_present: true,
      full_text_verified: true
    }
  };

  if (boundaryClean) applyBoundaryCleanDecoys(packet, ordinal);
  for (const faultId of faultIds) applyFaultMutation(packet, faultId);
  const injectedFaultIds = deriveReviewReasoningFaults(packet);
  return {
    case_id: caseId,
    source_fingerprint: sourceFingerprint,
    split,
    injected_fault_ids: injectedFaultIds,
    packet
  };
}

function applyBoundaryCleanDecoys(packet: ReviewReasoningBenchmarkPacket, ordinal: number): void {
  packet.comparison.required = false;
  packet.comparison.reference_declared = false;
  packet.comparison.reference_budget_units -= 25 + ordinal;
  packet.comparison.causal_comparison_claimed = false;
  packet.evaluation.independent_units = packet.evaluation.minimum_independent_units;
  packet.evaluation.repetitions = packet.evaluation.minimum_repetitions;
  packet.evaluation.uncertainty_required = false;
  packet.evaluation.uncertainty_reported = false;
  packet.citation_support.external_claim_present = false;
  packet.citation_support.full_text_verified = false;
}

function applyFaultMutation(
  packet: ReviewReasoningBenchmarkPacket,
  faultId: ReviewReasoningFaultId | undefined
): void {
  switch (faultId) {
    case "comparison_reference_missing":
      packet.comparison.reference_declared = false;
      return;
    case "independent_unit_floor_breached":
      packet.evaluation.independent_units = packet.evaluation.minimum_independent_units - 1;
      return;
    case "repetition_contract_unsatisfied":
      packet.evaluation.repetitions = packet.evaluation.minimum_repetitions - 1;
      return;
    case "uncertainty_omitted":
      packet.evaluation.uncertainty_reported = false;
      return;
    case "claim_scope_overreach":
      packet.claims.declared_scope = "universal";
      packet.claims.evidence_ceiling = "local";
      return;
    case "partition_overlap":
      packet.partitions.evaluation_fingerprints[0] = packet.partitions.development_fingerprints[0];
      return;
    case "metric_direction_reversed":
      packet.metric.declared_direction = packet.metric.contract_direction === "maximize" ? "minimize" : "maximize";
      return;
    case "comparison_budget_confounded":
      packet.comparison.subject_budget_units += 50;
      return;
    case "evidence_binding_mismatch":
      packet.evidence_binding.claimed_sha256 = hashCanonical({ caseId: packet.case_id, artifact: "different-evidence" });
      return;
    case "citation_support_unverified":
      packet.citation_support.full_text_verified = false;
      return;
    case undefined:
      return;
  }
}

function createAdjudicationCase(
  item: ReviewReasoningBenchmarkCase,
  index: number
): ReviewReasoningAdjudicationCase {
  const testFaults = FAULT_REGISTRY.filter((entry) => entry.split === "test").map((entry) => entry.fault_id);
  const supported = item.injected_fault_ids.map((faultId, findingIndex) => ({
    finding_id: "finding-" + (index + 1) + "-supported-" + (findingIndex + 1),
    fault_id: faultId,
    reviewer_role: findingIndex % 2 === 0 ? "methodology" : "reproducibility"
  }));
  const distractorFault = testFaults.find((faultId) => !item.injected_fault_ids.includes(faultId)) || testFaults[0];
  const candidateFindings: ReviewReasoningAdjudicationCase["candidate_findings"] = [
    ...supported,
    { finding_id: "finding-" + (index + 1) + "-distractor", fault_id: distractorFault, reviewer_role: "adversarial" }
  ];
  return {
    adjudication_id: "adjudication-" + String(index + 1).padStart(3, "0"),
    case_id: item.case_id,
    candidate_findings: candidateFindings,
    expected_adopted_finding_ids: supported.map((finding) => finding.finding_id)
  };
}

function renderReviewPacket(packet: ReviewReasoningBenchmarkPacket): string {
  const comparisonContract = packet.comparison.required
    ? "The protocol requires a named reference condition."
    : "The protocol defines this as a descriptive single-condition analysis and does not require a reference.";
  const reference = packet.comparison.reference_declared
    ? "A named reference condition is specified."
    : "No reference condition is named.";
  const attribution = packet.comparison.causal_comparison_claimed
    ? "The report attributes the observed difference to the condition itself."
    : "The report explicitly avoids a causal comparison claim.";
  const uncertaintyContract = packet.evaluation.uncertainty_required
    ? "The protocol requires an uncertainty or stability estimate."
    : "The registered protocol does not require an uncertainty estimate for this descriptive case.";
  const uncertainty = packet.evaluation.uncertainty_reported
    ? "The report includes an uncertainty interval."
    : "No uncertainty interval or stability estimate is reported.";
  const citation = packet.citation_support.external_claim_present
    ? packet.citation_support.full_text_verified
      ? "An external supporting claim is present and was checked against bound full text."
      : "An external supporting claim is present but was checked against metadata only; no bound full text was used."
    : "The packet makes no external supporting claim, and no full-text verification was performed.";
  return [
    comparisonContract + " " + reference,
    "The subject received " + packet.comparison.subject_budget_units + " budget units and the reference received " + packet.comparison.reference_budget_units + ". " + attribution,
    "The analysis uses " + packet.evaluation.independent_units + " independent units against a declared minimum of " + packet.evaluation.minimum_independent_units + ", with " + packet.evaluation.repetitions + " repetitions against a minimum of " + packet.evaluation.minimum_repetitions + ". " + uncertaintyContract + " " + uncertainty,
    "The evidence ceiling is " + packet.claims.evidence_ceiling + ", while the conclusion is stated at " + packet.claims.declared_scope + " scope.",
    "Development partition fingerprints are " + packet.partitions.development_fingerprints.join(", ") + "; evaluation partition fingerprints are " + packet.partitions.evaluation_fingerprints.join(", ") + ".",
    "The metric contract says to " + packet.metric.contract_direction + " " + packet.metric.name + "; the analysis treats " + packet.metric.declared_direction + " as improvement.",
    "The claimed evidence digest is " + packet.evidence_binding.claimed_sha256 + "; the observed artifact digest is " + packet.evidence_binding.observed_sha256 + ".",
    citation
  ].join(" ");

}

function aggregateEffort(
  effort: ReviewReasoningBenchmarkEffort,
  observations: ReviewReasoningBenchmarkObservation[]
): ReviewReasoningBenchmarkAggregate {
  const selected = observations.filter((item) => item.effort === effort);
  const completed = selected.filter((item) => item.status === "completed" && item.score);
  return {
    effort,
    completed_repetitions: completed.length,
    failed_repetitions: selected.length - completed.length,
    mean_defect_recall: mean(completed.map((item) => item.score!.defect_recall)),
    mean_defect_precision: mean(completed.map((item) => item.score!.defect_precision)),
    mean_clean_case_specificity: mean(completed.map((item) => item.score!.clean_case_specificity)),
    mean_exact_case_accuracy: mean(completed.map((item) => item.score!.exact_case_accuracy)),
    mean_adjudication_accuracy: mean(completed.map((item) => item.score!.adjudication_accuracy)),
    mean_adjudication_exact_accuracy: mean(completed.map((item) => item.score!.adjudication_exact_accuracy)),
    mean_latency_ms: mean(completed.map((item) => item.latency_ms)),
    total_input_tokens: sumKnown(completed.map((item) => item.usage?.inputTokens)),
    total_output_tokens: sumKnown(completed.map((item) => item.usage?.outputTokens))
  };
}

function buildBenchmarkDiagnostics(aggregates: ReviewReasoningBenchmarkAggregate[]): ReviewReasoningBenchmarkReport["diagnostics"] {
  const high = aggregates.find((item) => item.effort === "high");
  const xhigh = aggregates.find((item) => item.effort === "xhigh");
  const ceiling = high && xhigh ? hasCeilingEffect(high, xhigh) : false;
  const metrics = (item: ReviewReasoningBenchmarkAggregate | undefined) => item
    ? [item.mean_defect_recall, item.mean_defect_precision, item.mean_adjudication_accuracy]
    : [];
  const highMetrics = metrics(high);
  const xhighMetrics = metrics(xhigh);
  const separation = highMetrics.length > 0 && highMetrics.some((value, index) =>
    value !== null && xhighMetrics[index] !== null && Math.abs(value - xhighMetrics[index]!) >= 0.01
  );
  return {
    ceiling_effect_detected: Boolean(ceiling),
    reasoning_tier_separation_observed: separation,
    next_action: ceiling
      ? "Strengthen compound, boundary, and evidence-trace cases before adding repetitions."
      : separation
        ? "Run the preregistered matched repetition count before reviewing routing policy."
        : "Preserve the current routing policy until the benchmark yields informative matched evidence."
  };
}

function hasCeilingEffect(
  left: ReviewReasoningBenchmarkAggregate,
  right: ReviewReasoningBenchmarkAggregate
): boolean {
  const values = [
    left.mean_defect_recall, left.mean_defect_precision, left.mean_adjudication_accuracy,
    right.mean_defect_recall, right.mean_defect_precision, right.mean_adjudication_accuracy
  ];
  return values.every((value) => value !== null && value >= 0.99);
}

function buildPromotionDecision(
  comparison: ReviewReasoningPromotionDecision["comparison"],
  candidateEffort: ReviewReasoningBenchmarkEffort,
  referenceEffort: ReviewReasoningBenchmarkEffort,
  validation: ReviewReasoningSuiteValidation,
  split: ReviewReasoningBenchmarkSplit,
  repetitions: number,
  observations: ReviewReasoningBenchmarkObservation[],
  aggregates: ReviewReasoningBenchmarkAggregate[]
): ReviewReasoningPromotionDecision {
  const candidate = aggregates.find((item) => item.effort === candidateEffort);
  const reference = aggregates.find((item) => item.effort === referenceEffort);
  if (!candidate || !reference) {
    return {
      comparison,
      status: "not_evaluated",
      candidate_effort: candidateEffort,
      reference_effort: referenceEffort,
      reasons: ["Both requested reasoning tiers must be present in the same benchmark report."],
      observed_recall_delta: null,
      recall_delta_ci95: null,
      observed_precision_delta: null,
      observed_adjudication_delta: null
    };
  }

  const recallDelta = subtractKnown(candidate.mean_defect_recall, reference.mean_defect_recall);
  const precisionDelta = subtractKnown(candidate.mean_defect_precision, reference.mean_defect_precision);
  const adjudicationDelta = subtractKnown(candidate.mean_adjudication_accuracy, reference.mean_adjudication_accuracy);
  const ci = pairedBootstrapRecallDelta(candidateEffort, referenceEffort, observations);
  const reasons: string[] = [];
  if (!validation.valid || !validation.oracle_replay_passed) reasons.push("Suite validation and oracle replay must pass.");
  if (split !== "test") reasons.push("Only the held-out test split may change automatic routing policy.");
  if (validation.case_count < 30 || validation.fault_family_count < 10) reasons.push("The frozen suite is below the minimum scale for a routing change.");
  if (repetitions < 3) reasons.push("At least three matched repetitions are required.");
  if (candidate.failed_repetitions > 0 || reference.failed_repetitions > 0) reasons.push("All matched executions must complete and parse successfully.");
  if (hasCeilingEffect(candidate, reference)) reasons.push("Benchmark ceiling effect prevents a higher-tier routing decision.");
  reasons.push(...validateMatchedRouting(candidateEffort, referenceEffort, repetitions, observations));
  if (recallDelta === null || recallDelta < 0.03) reasons.push("Defect recall improvement must be at least 0.03.");
  if (!ci || ci[0] <= 0) reasons.push("The paired case-bootstrap 95% lower bound for recall improvement must exceed zero.");
  if (precisionDelta === null || precisionDelta < -0.02) reasons.push("Defect precision may not regress by more than 0.02.");
  if (adjudicationDelta === null || adjudicationDelta < -0.02) reasons.push("Adjudication accuracy may not regress by more than 0.02.");
  if (reasons.length === 0) reasons.push("All controlled routing promotion criteria passed.");
  return {
    comparison,
    status: reasons.length === 1 && reasons[0].startsWith("All controlled") ? "eligible" : "blocked",
    candidate_effort: candidateEffort,
    reference_effort: referenceEffort,
    reasons,
    observed_recall_delta: recallDelta,
    recall_delta_ci95: ci,
    observed_precision_delta: precisionDelta,
    observed_adjudication_delta: adjudicationDelta
  };
}

function validateMatchedRouting(
  candidateEffort: ReviewReasoningBenchmarkEffort,
  referenceEffort: ReviewReasoningBenchmarkEffort,
  repetitions: number,
  observations: ReviewReasoningBenchmarkObservation[]
): string[] {
  const reasons = new Set<string>();
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const pair = [candidateEffort, referenceEffort].map((effort) =>
      observations.find((item) => item.effort === effort && item.repetition === repetition)
    );
    if (pair.some((item) => !item || item.status !== "completed")) continue;
    const [candidate, reference] = pair as [ReviewReasoningBenchmarkObservation, ReviewReasoningBenchmarkObservation];
    if (candidate.input_sha256 !== reference.input_sha256) {
      reasons.add("Matched reasoning tiers must receive byte-identical benchmark inputs.");
    }
    if (candidate.response_repaired || reference.response_repaired) {
      reasons.add("Routing promotion requires strict provider JSON without truncation repair.");
    }
    for (const item of [candidate, reference]) {
      if (!item.provenance) {
        reasons.add("Every completed execution requires provider/model/reasoning provenance.");
      } else if (item.provenance.reasoningEffort !== item.effort) {
        reasons.add("Effective reasoning provenance must match the requested benchmark tier.");
      }
    }
    if (
      candidate.provenance
      && reference.provenance
      && (candidate.provenance.provider !== reference.provenance.provider
        || candidate.provenance.effectiveModel !== reference.provenance.effectiveModel)
    ) {
      reasons.add("Matched tiers must use the same effective provider and model.");
    }
  }
  return [...reasons];
}

function pairedBootstrapRecallDelta(
  candidateEffort: ReviewReasoningBenchmarkEffort,
  referenceEffort: ReviewReasoningBenchmarkEffort,
  observations: ReviewReasoningBenchmarkObservation[]
): [number, number] | null {
  const candidate = meanCaseOutcomes(observations.filter((item) => item.effort === candidateEffort));
  const reference = meanCaseOutcomes(observations.filter((item) => item.effort === referenceEffort));
  const caseIds = [...candidate.keys()].filter((caseId) => reference.has(caseId)).sort();
  if (caseIds.length < 2) return null;
  const random = mulberry32(20260804);
  const draws: number[] = [];
  for (let draw = 0; draw < 2000; draw += 1) {
    let delta = 0;
    for (let index = 0; index < caseIds.length; index += 1) {
      const caseId = caseIds[Math.floor(random() * caseIds.length)];
      delta += candidate.get(caseId)! - reference.get(caseId)!;
    }
    draws.push(delta / caseIds.length);
  }
  draws.sort((left, right) => left - right);
  return [draws[Math.floor(draws.length * 0.025)], draws[Math.floor(draws.length * 0.975)]];
}

function meanCaseOutcomes(observations: ReviewReasoningBenchmarkObservation[]): Map<string, number> {
  const values = new Map<string, number[]>();
  for (const observation of observations) {
    if (observation.status !== "completed") continue;
    for (const [caseId, outcome] of Object.entries(observation.case_outcomes || {})) {
      const existing = values.get(caseId) || [];
      existing.push(outcome.recall);
      values.set(caseId, existing);
    }
  }
  return new Map([...values].map(([caseId, items]) => [caseId, mean(items) || 0]));
}

function rotate<T>(items: T[], repetition: number): T[] {
  if (items.length === 0) return [];
  const offset = repetition % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

function setEquals(left: Set<unknown>, right: Set<unknown>): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sumKnown(values: Array<number | undefined>): number | null {
  const known = values.filter((value): value is number => typeof value === "number");
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
}

function subtractKnown(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left - right;
}

function formatMetric(value: number | null, digits = 3): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
