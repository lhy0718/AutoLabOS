import {
  validateActiveTopicProbeContract,
  type ActiveTopicProbeContract
} from "./activeTopicProbeContract.js";
import {
  effectCriterionValuesEqual,
  isEffectCriterion,
  isExplicitMetricScale
} from "./effectCriterion.js";
import {
  hashCanonical,
  type TopicPortfolio,
  type TopicPortfolioCandidate
} from "./researchFunnel.js";
import { isPriorAbsorptionCandidateProjection } from "./priorAbsorption.js";
import { isTopicProbeComputeBudgetLimits } from "./topicProbeComputeBudget.js";
import {
  buildGuidedResearchBriefMarkdown,
  validateResearchBriefMarkdown
} from "./runs/researchBriefFiles.js";
import {
  validateTopicProbeOutcomeDecision,
  type TopicProbeOutcomeDecision,
  type TopicProbeOutcomeDisposition,
  type TopicProbeOutcomeNextAction
} from "./topicProbeOutcome.js";
import type { RunSuccessorRelation } from "../types.js";
import {
  buildTopicProbeSuccessorRouteTarget,
  validateTopicProbeSuccessorRouteTarget,
  type TopicProbeSuccessorRouteTarget
} from "./topicProbeSuccessorRouteTarget.js";

export const TOPIC_PROBE_FOLLOWUP_HANDOFF_RELATIVE_PATH =
  "review/topic_probe_followup_handoff.json";

export type TopicProbeFollowupMode =
  | "hypothesis_test"
  | "topic_discovery";

export type TopicProbeFollowupEvidenceStage =
  | "confirmatory"
  | "bounded_probe"
  | "topic_refresh";

export interface TopicProbeFollowupHandoff {
  schema_version: 2;
  artifact_kind: "topic_probe_followup_handoff";
  parent_run_id: string;
  parent_research_cycle: number;
  candidate_id: string;
  topic_id: string;
  contract_content_sha256: string;
  outcome_content_sha256: string;
  candidate_content_sha256: string;
  source_portfolio_content_sha256: string;
  route_target: TopicProbeSuccessorRouteTarget;
  disposition: TopicProbeOutcomeDisposition;
  next_action: TopicProbeOutcomeNextAction;
  recommended_followup_mode: TopicProbeFollowupMode;
  evidence_stage: TopicProbeFollowupEvidenceStage;
  research_brief_markdown: string;
  content_sha256: string;
}

export interface TopicProbeFollowupHandoffInput {
  portfolio: TopicPortfolio;
  contract: ActiveTopicProbeContract;
  outcome: TopicProbeOutcomeDecision;
  candidate: TopicPortfolioCandidate;
}

export interface TopicProbeFollowupHandoffValidationContext
  extends TopicProbeFollowupHandoffInput {
  expectedRunId?: string;
  expectedResearchCycle?: number;
}

export interface TopicProbeFollowupHandoffValidation {
  measured: boolean;
  valid: boolean;
  reasons: string[];
  handoff?: TopicProbeFollowupHandoff;
  expectedHandoff?: TopicProbeFollowupHandoff;
}

const TOPIC_PROBE_FOLLOWUP_HANDOFF_FIELDS = new Set([
  "schema_version",
  "artifact_kind",
  "parent_run_id",
  "parent_research_cycle",
  "candidate_id",
  "topic_id",
  "contract_content_sha256",
  "outcome_content_sha256",
  "candidate_content_sha256",
  "source_portfolio_content_sha256",
  "route_target",
  "disposition",
  "next_action",
  "recommended_followup_mode",
  "evidence_stage",
  "research_brief_markdown",
  "content_sha256"
]);

const TOPIC_PORTFOLIO_CANDIDATE_FIELDS = new Set([
  "topic_id",
  "topic_lineage_id",
  "formulation_id",
  "formulation_version",
  "source_candidate_id",
  "statement",
  "gap_statement",
  "cluster_ids",
  "unresolved_cluster_ids",
  "supported_gap_ids",
  "evidence_links",
  "unresolved_evidence_links",
  "closest_prior_paper_ids",
  "closest_prior_full_text_paper_ids",
  "prior_absorption",
  "closest_prior_non_overlap",
  "reviewer_absorption_objection",
  "comparator",
  "dataset_task_bench",
  "primary_metric",
  "metric_unit",
  "metric_scale",
  "metric_direction",
  "meaningful_effect",
  "effect_criterion",
  "objective_raw",
  "falsifier",
  "local_budget",
  "brief_compute_budget_ceiling",
  "kill_signal",
  "contribution_claim",
  "minimum_publishable_evidence",
  "review_status",
  "probe_status",
  "review_summary",
  "topic_memory",
  "scores",
  "gates",
  "probe_eligible",
  "content_sha256"
]);

const RECOMPUTED_FIELDS: Array<Exclude<keyof TopicProbeFollowupHandoff, "content_sha256">> = [
  "schema_version",
  "artifact_kind",
  "parent_run_id",
  "parent_research_cycle",
  "candidate_id",
  "topic_id",
  "contract_content_sha256",
  "outcome_content_sha256",
  "candidate_content_sha256",
  "source_portfolio_content_sha256",
  "route_target",
  "disposition",
  "next_action",
  "recommended_followup_mode",
  "evidence_stage",
  "research_brief_markdown"
];

export function buildTopicProbeFollowupHandoff(
  input: TopicProbeFollowupHandoffInput
): TopicProbeFollowupHandoff {
  const sourceReasons = collectSourceChainReasons(input);
  if (sourceReasons.length > 0) {
    throw new Error(`topic_probe_followup_source_invalid:${sourceReasons.join(",")}`);
  }
  return buildExpectedHandoff(input);
}

export function validateTopicProbeFollowupHandoff(
  raw: string,
  context: TopicProbeFollowupHandoffValidationContext
): TopicProbeFollowupHandoffValidation {
  if (!raw.trim()) {
    return {
      measured: false,
      valid: false,
      reasons: ["topic_probe_followup_handoff_missing"]
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      measured: true,
      valid: false,
      reasons: ["topic_probe_followup_handoff_invalid_json"]
    };
  }
  if (!isTopicProbeFollowupHandoff(value)) {
    return {
      measured: true,
      valid: false,
      reasons: ["topic_probe_followup_handoff_schema_invalid"]
    };
  }

  const reasons: string[] = [];
  const { content_sha256: contentSha256, ...payload } = value;
  if (hashCanonical(payload) !== contentSha256) {
    reasons.push("topic_probe_followup_handoff_content_hash_mismatch");
  }
  if (
    context.expectedRunId !== undefined
    && value.parent_run_id !== context.expectedRunId
  ) {
    reasons.push("topic_probe_followup_handoff_parent_run_id_mismatch");
  }
  if (
    context.expectedResearchCycle !== undefined
    && value.parent_research_cycle !== context.expectedResearchCycle
  ) {
    reasons.push("topic_probe_followup_handoff_parent_research_cycle_mismatch");
  }

  for (const error of validateResearchBriefMarkdown(value.research_brief_markdown).errors) {
    reasons.push(`topic_probe_followup_handoff_brief_invalid:${error}`);
  }

  const sourceReasons = collectSourceChainReasons(context);
  reasons.push(...sourceReasons);
  const targetValidation = validateTopicProbeSuccessorRouteTarget(
    value.route_target,
    {
      portfolio: context.portfolio,
      contract: context.contract,
      outcome: context.outcome,
      activeCandidate: context.candidate
    }
  );
  reasons.push(...targetValidation.reasons);

  const sourceBindings: Array<[keyof TopicProbeFollowupHandoff, unknown]> = [
    ["parent_run_id", context.contract.run_id],
    ["parent_research_cycle", context.contract.research_cycle],
    ["candidate_id", context.candidate.source_candidate_id],
    ["topic_id", context.candidate.topic_id],
    ["contract_content_sha256", context.contract.content_sha256],
    ["outcome_content_sha256", context.outcome.content_sha256],
    ["candidate_content_sha256", context.candidate.content_sha256],
    ["source_portfolio_content_sha256", context.portfolio.content_sha256],
    ["disposition", context.outcome.disposition],
    ["next_action", context.outcome.next_action]
  ];
  for (const [field, expected] of sourceBindings) {
    if (!valuesEqual(value[field], expected)) {
      reasons.push(`topic_probe_followup_handoff_source_binding_mismatch:${String(field)}`);
    }
  }

  let expectedHandoff: TopicProbeFollowupHandoff | undefined;
  if (sourceReasons.length === 0) {
    expectedHandoff = buildExpectedHandoff(context);
    for (const field of RECOMPUTED_FIELDS) {
      if (!valuesEqual(value[field], expectedHandoff[field])) {
        reasons.push(`topic_probe_followup_handoff_recomputed_field_mismatch:${String(field)}`);
      }
    }
  }

  return {
    measured: true,
    valid: reasons.length === 0,
    reasons: uniqueStrings(reasons),
    handoff: value,
    ...(expectedHandoff ? { expectedHandoff } : {})
  };
}

function buildExpectedHandoff(
  input: TopicProbeFollowupHandoffInput
): TopicProbeFollowupHandoff {
  const routeTarget = buildTopicProbeSuccessorRouteTarget({
    portfolio: input.portfolio,
    contract: input.contract,
    outcome: input.outcome,
    activeCandidate: input.candidate
  });
  const payload: Omit<TopicProbeFollowupHandoff, "content_sha256"> = {
    schema_version: 2,
    artifact_kind: "topic_probe_followup_handoff",
    parent_run_id: input.contract.run_id,
    parent_research_cycle: input.contract.research_cycle,
    candidate_id: input.contract.candidate_id,
    topic_id: input.contract.topic_id,
    contract_content_sha256: input.contract.content_sha256,
    outcome_content_sha256: input.outcome.content_sha256,
    candidate_content_sha256: input.candidate.content_sha256,
    source_portfolio_content_sha256: input.portfolio.content_sha256,
    route_target: routeTarget,
    disposition: input.outcome.disposition,
    next_action: input.outcome.next_action,
    recommended_followup_mode: resolveTopicProbeFollowupMode(input.outcome.next_action),
    evidence_stage: resolveTopicProbeFollowupEvidenceStage(
      input.outcome.disposition,
      input.outcome.next_action
    ),
    research_brief_markdown: buildFollowupResearchBrief(input, routeTarget)
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

function collectSourceChainReasons(
  input: TopicProbeFollowupHandoffInput
): string[] {
  const reasons: string[] = [];
  const contractValidation = validateActiveTopicProbeContract(
    JSON.stringify(input.contract),
    {
      expectedRunId: input.contract.run_id,
      expectedResearchCycle: input.contract.research_cycle
    }
  );
  for (const reason of contractValidation.reasons) {
    reasons.push(`topic_probe_followup_contract_invalid:${reason}`);
  }

  reasons.push(...collectCandidateBindingReasons(input.candidate, input.contract));

  const outcomeValidation = validateTopicProbeOutcomeDecision(
    JSON.stringify(input.outcome),
    {
      expectedRunId: input.contract.run_id,
      expectedResearchCycle: input.contract.research_cycle,
      contract: input.contract
    }
  );
  for (const reason of outcomeValidation.reasons) {
    reasons.push(`topic_probe_followup_outcome_invalid:${reason}`);
  }
  return uniqueStrings(reasons);
}

function collectCandidateBindingReasons(
  candidate: TopicPortfolioCandidate,
  contract: ActiveTopicProbeContract
): string[] {
  if (!isTopicPortfolioCandidate(candidate)) {
    return ["topic_probe_followup_candidate_schema_invalid"];
  }

  const reasons: string[] = [];
  const { content_sha256: contentSha256, ...payload } = candidate;
  if (hashCanonical(payload) !== contentSha256) {
    reasons.push("topic_probe_followup_candidate_content_hash_mismatch");
  }
  if (!hasText(candidate.contribution_claim)) {
    reasons.push("topic_probe_followup_candidate_contribution_claim_missing");
  }
  if (!hasText(candidate.minimum_publishable_evidence)) {
    reasons.push("topic_probe_followup_candidate_minimum_publishable_evidence_missing");
  }

  const expectedBindings: Array<[string, unknown, unknown]> = [
    ["candidate_id", candidate.source_candidate_id, contract.candidate_id],
    ["topic_id", candidate.topic_id, contract.topic_id],
    ["candidate_content_sha256", candidate.content_sha256, contract.candidate_content_sha256],
    ["statement", candidate.statement, contract.statement],
    ["primary_metric", candidate.primary_metric, contract.primary_metric],
    ["metric_unit", candidate.metric_unit, contract.metric_unit],
    ["metric_scale", candidate.metric_scale, contract.metric_scale],
    ["metric_direction", candidate.metric_direction, contract.metric_direction],
    ["objective_raw", candidate.objective_raw, contract.objective_raw],
    ["meaningful_effect", candidate.meaningful_effect, contract.meaningful_effect],
    ["comparator", candidate.comparator, contract.comparator],
    ["dataset_task_bench", candidate.dataset_task_bench, contract.dataset_task_bench],
    ["falsifier", candidate.falsifier, contract.falsifier],
    ["kill_signal", candidate.kill_signal, contract.kill_signal],
    ["local_budget", candidate.local_budget, contract.local_budget]
  ];
  for (const [field, candidateValue, contractValue] of expectedBindings) {
    if (!valuesEqual(candidateValue, contractValue)) {
      reasons.push(`topic_probe_followup_candidate_contract_binding_mismatch:${field}`);
    }
  }
  if (!effectCriterionValuesEqual(candidate.effect_criterion, contract.effect_criterion)) {
    reasons.push(
      "topic_probe_followup_candidate_contract_binding_mismatch:effect_criterion"
    );
  }
  return reasons;
}

function buildFollowupResearchBrief(
  input: TopicProbeFollowupHandoffInput,
  routeTarget: TopicProbeSuccessorRouteTarget
): string {
  const { contract, outcome, candidate } = input;
  const contributionClaim = requireCandidateText(
    candidate.contribution_claim,
    "contribution_claim"
  );
  const minimumPublishableEvidence = requireCandidateText(
    candidate.minimum_publishable_evidence,
    "minimum_publishable_evidence"
  );
  const mode = resolveTopicProbeFollowupMode(outcome.next_action);
  const effectCriterion = JSON.stringify(contract.effect_criterion);
  const frozenContract = JSON.stringify({
    statement: contract.statement,
    comparator: contract.comparator,
    dataset_task_bench: contract.dataset_task_bench,
    primary_metric: contract.primary_metric,
    metric_unit: contract.metric_unit,
    metric_scale: contract.metric_scale,
    metric_direction: contract.metric_direction,
    effect_criterion: contract.effect_criterion,
    falsifier: contract.falsifier,
    kill_signal: contract.kill_signal,
    local_budget: contract.local_budget,
    contribution_claim: contributionClaim,
    minimum_publishable_evidence: minimumPublishableEvidence
  }, null, 2);
  const metricDescription = [
    `primary_metric=${contract.primary_metric}`,
    `unit=${contract.metric_unit}`,
    `scale=${contract.metric_scale}`,
    `direction=${contract.metric_direction}`
  ].join(", ");
  const sourceNotes = [
    `Follow-up route: disposition=${outcome.disposition}, next_action=${outcome.next_action}.`,
    `Parent context: run_id=${contract.run_id}, research_cycle=${contract.research_cycle}.`,
    [
      "Source bindings:",
      `contract_sha256=${contract.content_sha256},`,
      `outcome_sha256=${outcome.content_sha256},`,
      `candidate_sha256=${candidate.content_sha256}.`
    ].join(" "),
    [
      "Route target bindings:",
      `portfolio_sha256=${input.portfolio.content_sha256},`,
      `route_target_sha256=${routeTarget.content_sha256},`,
      `policy=${routeTarget.policy}.`
    ].join(" "),
    "Frozen source candidate contract:",
    "```json",
    frozenContract,
    "```"
  ].join("\n");
  const boundedProbeClaimGuard =
    "The bounded probe alone must not be used as evidence for paper claims.";
  const confirmatoryRequirement = [
    "Real confirmatory repetitions are required.",
    "Report uncertainty, the named baseline comparison, and failure analysis.",
    "Map every retained claim to the resulting evidence."
  ].join(" ");

  const route = buildRouteBriefContent({
    contract,
    outcome,
    candidate,
    contributionClaim,
    minimumPublishableEvidence,
    metricDescription,
    effectCriterion,
    boundedProbeClaimGuard,
    confirmatoryRequirement,
    routeTarget
  });
  const markdown = buildGuidedResearchBriefMarkdown({
    researchMode: mode,
    topic: route.topic,
    scientificObject: "bounded topic evaluation",
    empiricalProblems: [
      `Effect-floor stability for ${contract.primary_metric}.`,
      `Comparison validity under ${contract.dataset_task_bench}.`
    ].join("\n"),
    priorWorkProbes: [
      "Test whether the closest full-text priors absorb the revised contribution.",
      `Compare against the frozen strongest baseline: ${contract.comparator}.`
    ].join("\n"),
    primaryMetric: route.primaryMetric,
    secondaryMetrics:
      "Uncertainty estimates, execution-integrity counts, and failure-analysis indicators.",
    meaningfulImprovement: route.meaningfulImprovement,
    constraints: route.constraints.join("\n"),
    researchQuestion: route.researchQuestion,
    whySmallExperiment: route.whySmallExperiment.join("\n"),
    baselineComparator: route.baselineComparator.join("\n"),
    datasetTaskBench: route.datasetTaskBench.join("\n"),
    targetComparison: route.targetComparison.join("\n"),
    minimumAcceptableEvidence: route.minimumAcceptableEvidence.join("\n"),
    disallowedShortcuts: route.disallowedShortcuts.join("\n"),
    allowedBudgetedPasses: route.allowedBudgetedPasses.join("\n"),
    paperCeiling: "blocked_for_paper_scale",
    minimumExperimentPlan: route.minimumExperimentPlan.join("\n"),
    failureConditions: route.failureConditions.join("\n"),
    appendixPrefer:
      "per_run_results\nuncertainty_analysis\nfailure_analysis\nenvironment_manifest",
    appendixKeepMain:
      "primary_result_table\nbaseline_comparison\nclaim_evidence_mapping",
    notes: sourceNotes,
    questionsRisks: route.questionsRisks.join("\n")
  });
  const validation = validateResearchBriefMarkdown(markdown);
  if (validation.errors.length > 0) {
    throw new Error(
      `topic_probe_followup_generated_brief_invalid:${validation.errors.join("|")}`
    );
  }
  return markdown;
}

interface RouteBriefInput {
  contract: ActiveTopicProbeContract;
  outcome: TopicProbeOutcomeDecision;
  candidate: TopicPortfolioCandidate;
  contributionClaim: string;
  minimumPublishableEvidence: string;
  metricDescription: string;
  effectCriterion: string;
  boundedProbeClaimGuard: string;
  confirmatoryRequirement: string;
  routeTarget: TopicProbeSuccessorRouteTarget;
}

interface RouteBriefContent {
  topic: string;
  primaryMetric: string;
  meaningfulImprovement: string;
  constraints: string[];
  researchQuestion: string;
  whySmallExperiment: string[];
  baselineComparator: string[];
  datasetTaskBench: string[];
  targetComparison: string[];
  minimumAcceptableEvidence: string[];
  disallowedShortcuts: string[];
  allowedBudgetedPasses: string[];
  minimumExperimentPlan: string[];
  failureConditions: string[];
  questionsRisks: string[];
}

function buildRouteBriefContent(input: RouteBriefInput): RouteBriefContent {
  const {
    contract,
    outcome,
    candidate,
    contributionClaim,
    minimumPublishableEvidence,
    metricDescription,
    effectCriterion,
    boundedProbeClaimGuard,
    confirmatoryRequirement,
    routeTarget
  } = input;
  const frozenConstraints = [
    `Frozen candidate statement: ${contract.statement}`,
    `Frozen comparator: ${contract.comparator}`,
    `Frozen dataset/task/bench: ${contract.dataset_task_bench}`,
    `Frozen falsifier: ${contract.falsifier}`,
    `Frozen kill signal: ${contract.kill_signal}`,
    `Frozen local budget: ${contract.local_budget}`,
    `Machine-readable compute ceiling: ${JSON.stringify(contract.brief_compute_budget_ceiling)}`,
    "Any change to a frozen field requires a new hash-bound contract and handoff."
  ];
  const frozenBaseline = [
    `Baseline / comparator: ${contract.comparator}`,
    "Use the same declared evaluation protocol for the baseline and candidate condition.",
    `Primary comparison dimension: ${metricDescription}`
  ];
  const frozenDataset = [
    `Dataset / task / bench: ${contract.dataset_task_bench}`,
    "Freeze the evaluation units, split discipline, preprocessing, and exclusions before outcomes are opened.",
    "Record all execution failures and exclusions."
  ];
  const frozenTarget = [
    `Candidate statement: ${contract.statement}`,
    `Comparator: ${contract.comparator}`,
    `Primary metric contract: ${metricDescription}`,
    `Structured effect criterion: ${effectCriterion}`
  ];
  const frozenEvidence = [
    `Frozen minimum_publishable_evidence: ${minimumPublishableEvidence}`,
    `Frozen contribution_claim: ${contributionClaim}`,
    `Structured effect criterion: ${effectCriterion}`
  ];
  const claimGuards = [
    boundedProbeClaimGuard,
    "Do not alter the metric, unit, scale, direction, comparator, or effect criterion after observing results.",
    "Do not omit failed runs, uncertainty estimates, baseline results, or adverse failure analysis.",
    "Do not draft beyond the evidence ceiling recorded in this brief."
  ];
  const failureConditions = [
    `Falsifier: ${contract.falsifier}`,
    `Kill signal: ${contract.kill_signal}`,
    "The primary metric cannot be bound to the declared unit, scale, direction, or structured effect criterion.",
    "The baseline or candidate condition cannot be executed under the same declared protocol."
  ];

  if (outcome.next_action === "start_confirmatory_run") {
    return {
      topic: contract.statement,
      primaryMetric: contract.objective_raw,
      meaningfulImprovement:
        `The frozen structured effect criterion is ${effectCriterion}.`,
      constraints: frozenConstraints,
      researchQuestion: [
        "Under the frozen candidate statement, does the candidate condition meet",
        `${effectCriterion} against ${contract.comparator} on`,
        `${contract.dataset_task_bench}?`
      ].join(" "),
      whySmallExperiment: [
        "The bounded probe supports promotion but does not constitute confirmatory evidence.",
        "The comparator, evaluation scope, endpoint, and falsifier are already frozen.",
        confirmatoryRequirement
      ],
      baselineComparator: frozenBaseline,
      datasetTaskBench: frozenDataset,
      targetComparison: frozenTarget,
      minimumAcceptableEvidence: [
        ...frozenEvidence,
        confirmatoryRequirement,
        "Include a quantitative result table and explicit claim-to-evidence mapping."
      ],
      disallowedShortcuts: [
        ...claimGuards,
        "Do not count the bounded probe as sufficient confirmatory repetition."
      ],
      allowedBudgetedPasses: [
        `Frozen local budget: ${contract.local_budget}`,
        "Only predeclared confirmatory repetitions and integrity repairs may use the budget.",
        "Issue a new governed handoff before exceeding or changing the budget."
      ],
      minimumExperimentPlan: [
        "Run the named baseline and candidate condition in real confirmatory repetitions.",
        "Estimate uncertainty for the frozen primary metric and structured effect criterion.",
        "Produce a quantitative comparison table, failure analysis, limitations, and claim-to-evidence mapping."
      ],
      failureConditions: [
        ...failureConditions,
        "Confirmatory repetitions, uncertainty, baseline comparison, or failure analysis remain missing.",
        "The observed confirmatory effect fails the frozen structured effect criterion."
      ],
      questionsRisks: [
        "Can the confirmatory repetitions remain independent and protocol-matched?",
        "Does uncertainty still support the frozen contribution claim?"
      ]
    };
  }

  if (outcome.next_action === "repeat_bounded_probe") {
    return {
      topic: `Repeat the bounded probe for: ${contract.statement}`,
      primaryMetric: contract.objective_raw,
      meaningfulImprovement:
        `The unchanged structured effect criterion is ${effectCriterion}.`,
      constraints: [
        ...frozenConstraints,
        `Repeat reasons: ${outcome.reason_codes.join(", ")}`
      ],
      researchQuestion:
        "Does a fresh bounded repetition resolve the declared probe-evidence gap without changing the frozen candidate contract?",
      whySmallExperiment: [
        "The prior probe was promising but did not satisfy the promotion prerequisites.",
        "A bounded repetition can resolve only the recorded trial-count or uncertainty gap.",
        "The repeat remains probe evidence and cannot establish a paper claim."
      ],
      baselineComparator: frozenBaseline,
      datasetTaskBench: frozenDataset,
      targetComparison: frozenTarget,
      minimumAcceptableEvidence: [
        ...frozenEvidence,
        "Supply the missing fresh repetition or primary-metric uncertainty estimate.",
        "Promotion still requires a separately governed confirmatory run."
      ],
      disallowedShortcuts: claimGuards,
      allowedBudgetedPasses: [
        `Frozen local budget: ${contract.local_budget}`,
        "Permit only the bounded repetition needed to resolve the recorded reason codes.",
        "Stop when the budget or kill signal is reached."
      ],
      minimumExperimentPlan: [
        "Repeat the baseline and candidate comparison under the unchanged protocol.",
        "Record fresh-trial counts, uncertainty, a quantitative result, and all failures.",
        "Issue a new outcome decision; do not draft paper claims from the repeat."
      ],
      failureConditions: [
        ...failureConditions,
        "The repeat does not resolve every recorded promotion prerequisite.",
        "The repeat requires changing a frozen field."
      ],
      questionsRisks: [
        "Will the repeat provide independent fresh evidence?",
        "Can the missing uncertainty estimate be computed without changing the endpoint?"
      ]
    };
  }

  if (outcome.next_action === "try_deferred_candidate") {
    const selected = routeTarget.target_candidate;
    if (!selected) {
      throw new Error("topic_probe_followup_deferred_route_target_missing");
    }
    const selectedComparator = requireCandidateText(
      selected.comparator,
      "deferred_comparator"
    );
    const selectedBench = requireCandidateText(
      selected.dataset_task_bench,
      "deferred_dataset_task_bench"
    );
    const selectedObjective = requireCandidateText(
      selected.objective_raw,
      "deferred_objective_raw"
    );
    const selectedContribution = requireCandidateText(
      selected.contribution_claim,
      "deferred_contribution_claim"
    );
    const selectedMinimumEvidence = requireCandidateText(
      selected.minimum_publishable_evidence,
      "deferred_minimum_publishable_evidence"
    );
    const selectedLocalBudget = requireCandidateText(
      selected.local_budget,
      "deferred_local_budget"
    );
    const selectedEffectCriterion = JSON.stringify(selected.effect_criterion);
    return {
      topic: selected.statement,
      primaryMetric: selectedObjective,
      meaningfulImprovement:
        `The selected candidate's structured effect criterion is ${selectedEffectCriterion}.`,
      constraints: [
        `Selected deferred candidate: ${selected.source_candidate_id}`,
        `Selected candidate content hash: ${selected.content_sha256}`,
        `Source portfolio content hash: ${routeTarget.source_portfolio_content_sha256}`,
        `Remaining deferred candidate IDs: ${routeTarget.remaining_deferred_candidate_ids.join(", ") || "none"}`,
        "Validate the selected candidate against the hash-bound source portfolio.",
        "Create a fresh active-topic-probe contract before any execution.",
        boundedProbeClaimGuard
      ],
      researchQuestion:
        "Does one authorized deferred candidate support a falsifiable bounded probe under its own frozen contract?",
      whySmallExperiment: [
        "The current candidate was rejected by a validated bounded outcome.",
        "The portfolio already identifies a bounded set of deferred candidates.",
        "Execution begins only after the selected deferred candidate supplies a complete candidate-owned contract."
      ],
      baselineComparator: [
        `Baseline / comparator: ${selectedComparator}`,
        "Reject the handoff if that comparator is missing or cannot be executed.",
        "Do not infer a baseline from labels or from the rejected candidate."
      ],
      datasetTaskBench: [
        `Dataset / task / bench: ${selectedBench}`,
        "Freeze its split discipline and exclusions before outcomes are opened.",
        "Do not inherit the rejected candidate's evaluation scope."
      ],
      targetComparison: [
        `Candidate statement: ${selected.statement}`,
        `Comparator: ${selectedComparator}`,
        `Structured effect criterion: ${selectedEffectCriterion}`,
        "Run only one authorized bounded probe."
      ],
      minimumAcceptableEvidence: [
        `Selected contribution_claim: ${selectedContribution}`,
        `Selected minimum_publishable_evidence: ${selectedMinimumEvidence}`,
        `Rejected candidate contribution_claim retained for audit: ${contributionClaim}`,
        `Rejected candidate minimum_publishable_evidence retained for audit: ${minimumPublishableEvidence}`,
        "Bounded evidence may authorize promotion or rejection only; it cannot support paper claims."
      ],
      disallowedShortcuts: [
        boundedProbeClaimGuard,
        "Do not execute an unlisted candidate.",
        "Do not transfer the rejected candidate's metric, comparator, data, effect criterion, or claim.",
        "Do not skip creation and validation of a fresh active-topic-probe contract."
      ],
      allowedBudgetedPasses: [
        `Use only the selected candidate's local budget: ${selectedLocalBudget}`,
        "Permit one bounded probe and only predeclared integrity repair.",
        "Return to portfolio refresh if no deferred candidate remains valid."
      ],
      minimumExperimentPlan: [
        "Select and validate one authorized deferred candidate.",
        "Build its fresh hash-bound active probe contract.",
        "Run its comparator and candidate condition, record a quantitative result and failures, then issue a new outcome decision."
      ],
      failureConditions: [
        "No authorized deferred candidate remains valid.",
        "The selected candidate lacks a contribution claim, minimum publishable evidence, comparator, endpoint, data source, falsifier, or local budget.",
        "A fresh source-bound active probe contract cannot be produced."
      ],
      questionsRisks: [
        "Which authorized deferred candidate remains strongest after source validation?",
        "Does prior evidence absorb the selected deferred candidate's contribution claim?"
      ]
    };
  }

  if (outcome.next_action === "refresh_topic_portfolio") {
    return {
      topic: `Refresh the topic portfolio after rejecting: ${contract.statement}`,
      primaryMetric:
        "Every refreshed candidate must declare one primary metric with an explicit unit, numeric scale, and direction.",
      meaningfulImprovement:
        "Every refreshed candidate must declare its own structured effect criterion before probe authorization.",
      constraints: [
        "Preserve the validated rejection and do not silently revive the rejected candidate.",
        "Change the contribution object and at least three counted topic-memory axes among contribution object, method mechanism, data/task scope, and evaluation protocol.",
        "Do not satisfy portfolio refresh through identifier changes, wording-only paraphrases, a dataset swap, or a metric swap around the rejected research object.",
        "Generate only source-grounded, candidate-owned contracts.",
        "Require a comparator, dataset / task / bench, falsifier, kill signal, local budget, contribution claim, and minimum publishable evidence.",
        "Authorize no execution until the refreshed portfolio and selected candidate are hash-bound."
      ],
      researchQuestion:
        "Which source-grounded candidate remains novel, falsifiable, and feasible after the validated rejection?",
      whySmallExperiment: [
        "Portfolio refresh is a bounded topic-discovery step, not an experiment.",
        "Each retained candidate must support a later small real probe under its own frozen contract.",
        "The rejected bounded probe constrains the search but supplies no paper claim."
      ],
      baselineComparator: [
        "Each refreshed candidate must name its own relevant comparator.",
        "Reviewers must test whether the closest prior already absorbs the proposed comparison.",
        "No baseline may be inferred from candidate labels."
      ],
      datasetTaskBench: [
        "Each refreshed candidate must bind an accessible dataset / task / bench.",
        "Require a feasible split or validation discipline and explicit limitations.",
        "Reject candidates whose evaluation source cannot support a small real probe."
      ],
      targetComparison: [
        "For each candidate, bind the proposed condition, comparator, primary endpoint, expected direction, and falsifier.",
        "Adversarially review the portfolio before authorizing exactly one bounded probe.",
        "Defer the remaining eligible candidates explicitly."
      ],
      minimumAcceptableEvidence: [
        "Require primary-source support and a closest-prior non-overlap argument for every retained candidate.",
        "Require a machine-readable changed-axis audit against the rejected topic-memory descriptor.",
        "Require complete candidate-owned contracts before probe authorization.",
        `Rejected candidate contribution_claim retained as a non-supported boundary: ${contributionClaim}`,
        `Rejected candidate minimum_publishable_evidence retained as an unmet ceiling: ${minimumPublishableEvidence}`
      ],
      disallowedShortcuts: [
        boundedProbeClaimGuard,
        "Do not recast the rejected candidate as supported.",
        "Do not promote a candidate without a fresh source-bound portfolio and active probe contract.",
        "Do not use workflow completion, smoke artifacts, or abstract-only impressions as experimental evidence."
      ],
      allowedBudgetedPasses: [
        "Use one bounded portfolio-refresh pass.",
        "Permit one adversarial review pass before selecting a probe candidate.",
        "Start no experiment within the topic-refresh stage."
      ],
      minimumExperimentPlan: [
        "Produce a refreshed source-bound candidate portfolio.",
        "Record closest-prior objections, candidate-owned contracts, and explicit reject/defer decisions.",
        "Authorize exactly one bounded probe only after every frozen gate passes."
      ],
      failureConditions: [
        "No candidate has adequate source support or closest-prior non-overlap.",
        "No candidate changes the required contribution object and minimum number of counted topic-memory axes.",
        "No candidate supplies a complete comparator, endpoint, data source, falsifier, budget, contribution claim, and minimum evidence threshold.",
        "The refreshed portfolio cannot authorize one bounded real probe."
      ],
      questionsRisks: [
        "Which evidence gap remains after accounting for the validated rejection?",
        "Does the refreshed portfolio change the research problem, or merely rename the same intervention and evaluation?",
        "Can any refreshed candidate survive the strongest novelty-absorption objection?"
      ]
    };
  }

  return {
    topic: `Repair bounded-probe evidence for: ${contract.statement}`,
    primaryMetric: contract.objective_raw,
    meaningfulImprovement:
      `The unchanged structured effect criterion is ${effectCriterion}.`,
    constraints: [
      ...frozenConstraints,
      `Invalid-evidence reasons: ${outcome.reason_codes.join(", ")}`,
      "Repair evidence provenance or execution integrity before interpreting effect direction."
    ],
    researchQuestion:
      "Can the bounded probe evidence be repaired and rerun under the unchanged contract so that a valid outcome can be computed?",
    whySmallExperiment: [
      "The outcome is blocked by evidence validity rather than by a defensible effect estimate.",
      "A bounded repair can restore the declared comparison, trial accounting, or execution integrity.",
      "No scientific conclusion is allowed until a new valid outcome decision exists."
    ],
    baselineComparator: frozenBaseline,
    datasetTaskBench: frozenDataset,
    targetComparison: frozenTarget,
    minimumAcceptableEvidence: [
      ...frozenEvidence,
      "Resolve every invalid-evidence reason code and produce a new hash-bound outcome decision.",
      "A repaired bounded probe may decide promotion, rejection, or repetition only."
    ],
    disallowedShortcuts: [
      ...claimGuards,
      "Do not reinterpret missing, cached-only, mismatched, or failed evidence as a valid effect."
    ],
    allowedBudgetedPasses: [
      `Frozen local budget: ${contract.local_budget}`,
      "Permit only evidence-integrity repair and the minimum fresh rerun required by the reason codes.",
      "Stop if repair requires changing a frozen scientific field."
    ],
    minimumExperimentPlan: [
      "Repair the primary-comparison binding, trial accounting, metric metadata, or execution failure.",
      "Rerun the baseline and candidate condition when fresh evidence is required.",
      "Record uncertainty and failures, then issue a new source-bound outcome decision."
    ],
    failureConditions: [
      ...failureConditions,
      "Any invalid-evidence reason remains unresolved.",
      "Repair requires changing the frozen metric, comparator, effect criterion, or data scope."
    ],
    questionsRisks: [
      "Which invalid-evidence reason is causal rather than downstream?",
      "Can the repair preserve the frozen comparison and local budget?"
    ]
  };
}

export function resolveTopicProbeFollowupMode(
  nextAction: TopicProbeOutcomeNextAction
): TopicProbeFollowupMode {
  return nextAction === "start_confirmatory_run"
    ? "hypothesis_test"
    : "topic_discovery";
}

export function resolveTopicProbeFollowupEvidenceStage(
  disposition: TopicProbeOutcomeDisposition,
  nextAction: TopicProbeOutcomeNextAction
): TopicProbeFollowupEvidenceStage {
  if (disposition === "promote_to_confirmatory") {
    return "confirmatory";
  }
  return nextAction === "refresh_topic_portfolio"
    ? "topic_refresh"
    : "bounded_probe";
}

export function resolveTopicProbeSuccessorRelation(
  nextAction: TopicProbeOutcomeNextAction
): RunSuccessorRelation {
  switch (nextAction) {
    case "start_confirmatory_run":
      return "topic_probe_confirmatory";
    case "repeat_bounded_probe":
      return "topic_probe_repeat";
    case "try_deferred_candidate":
      return "topic_probe_deferred_candidate";
    case "refresh_topic_portfolio":
      return "topic_probe_portfolio_refresh";
    case "repair_probe_evidence":
      return "topic_probe_evidence_repair";
  }
}

function isTopicProbeFollowupHandoff(
  value: unknown
): value is TopicProbeFollowupHandoff {
  if (
    !isRecord(value)
    || !hasOnlyKnownFields(value, TOPIC_PROBE_FOLLOWUP_HANDOFF_FIELDS)
  ) {
    return false;
  }
  return value.schema_version === 2
    && value.artifact_kind === "topic_probe_followup_handoff"
    && hasText(value.parent_run_id)
    && isNonNegativeInteger(value.parent_research_cycle)
    && hasText(value.candidate_id)
    && hasText(value.topic_id)
    && isSha256(value.contract_content_sha256)
    && isSha256(value.outcome_content_sha256)
    && isSha256(value.candidate_content_sha256)
    && isSha256(value.source_portfolio_content_sha256)
    && isRecord(value.route_target)
    && isDisposition(value.disposition)
    && isNextAction(value.next_action)
    && nextActionMatchesDisposition(value.disposition, value.next_action)
    && isFollowupMode(value.recommended_followup_mode)
    && isEvidenceStage(value.evidence_stage)
    && hasText(value.research_brief_markdown)
    && isSha256(value.content_sha256);
}

function isTopicPortfolioCandidate(
  value: unknown
): value is TopicPortfolioCandidate {
  if (
    !isRecord(value)
    || !hasOnlyKnownFields(value, TOPIC_PORTFOLIO_CANDIDATE_FIELDS)
  ) {
    return false;
  }
  const scores = value.scores;
  return hasText(value.topic_id)
    && isOptionalString(value.topic_lineage_id)
    && isOptionalString(value.formulation_id)
    && (
      value.formulation_version === undefined
      || (isNonNegativeInteger(value.formulation_version)
        && value.formulation_version > 0)
    )
    && hasText(value.source_candidate_id)
    && hasText(value.statement)
    && isOptionalString(value.gap_statement)
    && isStringArray(value.cluster_ids)
    && isStringArray(value.unresolved_cluster_ids)
    && isStringArray(value.supported_gap_ids)
    && isStringArray(value.evidence_links)
    && isStringArray(value.unresolved_evidence_links)
    && isStringArray(value.closest_prior_paper_ids)
    && isStringArray(value.closest_prior_full_text_paper_ids)
    && (
      value.prior_absorption === undefined
      || isPriorAbsorptionCandidateProjection(value.prior_absorption)
    )
    && isOptionalString(value.closest_prior_non_overlap)
    && isOptionalString(value.reviewer_absorption_objection)
    && isOptionalString(value.comparator)
    && isOptionalString(value.dataset_task_bench)
    && isOptionalString(value.primary_metric)
    && isOptionalString(value.metric_unit)
    && (value.metric_scale === undefined || isExplicitMetricScale(value.metric_scale))
    && (
      value.metric_direction === undefined
      || value.metric_direction === "maximize"
      || value.metric_direction === "minimize"
    )
    && isOptionalString(value.meaningful_effect)
    && (value.effect_criterion === undefined || isEffectCriterion(value.effect_criterion))
    && isOptionalString(value.objective_raw)
    && isOptionalString(value.falsifier)
    && isOptionalString(value.local_budget)
    && (
      value.brief_compute_budget_ceiling === undefined
      || isTopicProbeComputeBudgetLimits(value.brief_compute_budget_ceiling)
    )
    && isOptionalString(value.kill_signal)
    && isOptionalString(value.contribution_claim)
    && isOptionalString(value.minimum_publishable_evidence)
    && (
      value.review_status === "kept"
      || value.review_status === "rejected"
      || value.review_status === "not_reviewed"
    )
    && (
      value.probe_status === "shortlisted"
      || value.probe_status === "not_shortlisted"
    )
    && isOptionalString(value.review_summary)
    && (value.topic_memory === undefined || isRecord(value.topic_memory))
    && isRecord(scores)
    && ["novelty", "feasibility", "testability", "cost", "expected_gain"].every(
      (field) => typeof scores[field] === "number" && Number.isFinite(scores[field])
    )
    && hasOnlyKnownFields(
      scores,
      new Set(["novelty", "feasibility", "testability", "cost", "expected_gain"])
    )
    && Array.isArray(value.gates)
    && value.gates.every(isResearchFunnelGate)
    && typeof value.probe_eligible === "boolean"
    && isSha256(value.content_sha256);
}

function isResearchFunnelGate(value: unknown): boolean {
  return isRecord(value)
    && hasOnlyKnownFields(value, new Set(["code", "status", "message"]))
    && typeof value.code === "string"
    && (value.status === "pass" || value.status === "block")
    && typeof value.message === "string";
}

function isDisposition(value: unknown): value is TopicProbeOutcomeDisposition {
  return value === "promote_to_confirmatory"
    || value === "reject_candidate"
    || value === "repeat_probe"
    || value === "blocked_invalid_evidence";
}

function isNextAction(value: unknown): value is TopicProbeOutcomeNextAction {
  return value === "start_confirmatory_run"
    || value === "try_deferred_candidate"
    || value === "refresh_topic_portfolio"
    || value === "repeat_bounded_probe"
    || value === "repair_probe_evidence";
}

function nextActionMatchesDisposition(
  disposition: TopicProbeOutcomeDisposition,
  nextAction: TopicProbeOutcomeNextAction
): boolean {
  if (disposition === "promote_to_confirmatory") {
    return nextAction === "start_confirmatory_run";
  }
  if (disposition === "reject_candidate") {
    return nextAction === "try_deferred_candidate"
      || nextAction === "refresh_topic_portfolio";
  }
  if (disposition === "repeat_probe") {
    return nextAction === "repeat_bounded_probe";
  }
  return nextAction === "repair_probe_evidence";
}

function isFollowupMode(value: unknown): value is TopicProbeFollowupMode {
  return value === "hypothesis_test" || value === "topic_discovery";
}

function isEvidenceStage(
  value: unknown
): value is TopicProbeFollowupEvidenceStage {
  return value === "confirmatory"
    || value === "bounded_probe"
    || value === "topic_refresh";
}

function requireCandidateText(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new Error(`topic_probe_followup_candidate_${field}_missing`);
  }
  return normalized;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKnownFields(
  value: object,
  fields: ReadonlySet<string>
): boolean {
  return Object.keys(value).every((key) => fields.has(key));
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
