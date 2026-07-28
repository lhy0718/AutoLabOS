export type GraphNodeId =
  | "collect_papers"
  | "analyze_papers"
  | "generate_hypotheses"
  | "design_experiments"
  | "implement_experiments"
  | "run_experiments"
  | "analyze_results"
  | "figure_audit"
  | "review"
  | "write_paper";

export const GRAPH_NODE_ORDER: GraphNodeId[] = [
  "collect_papers",
  "analyze_papers",
  "generate_hypotheses",
  "design_experiments",
  "implement_experiments",
  "run_experiments",
  "analyze_results",
  "figure_audit",
  "review",
  "write_paper"
];

// Backward-compatible alias for previously shipped command/UI logic.
export type AgentId = GraphNodeId;
export const AGENT_ORDER: AgentId[] = [...GRAPH_NODE_ORDER];

export type AgentRoleId =
  | "collector_curator"
  | "reader_evidence_extractor"
  | "hypothesis_agent"
  | "experiment_designer"
  | "implementer"
  | "runner"
  | "analyst_statistician"
  | "paper_writer"
  | "reviewer";

export const AGENT_ROLE_ORDER: AgentRoleId[] = [
  "collector_curator",
  "reader_evidence_extractor",
  "hypothesis_agent",
  "experiment_designer",
  "implementer",
  "runner",
  "analyst_statistician",
  "paper_writer",
  "reviewer"
];

export type NodeStatus = "pending" | "running" | "needs_approval" | "completed" | "failed" | "skipped";
export type AgentStatus = NodeStatus;
export type WorkflowApprovalMode = "manual" | "minimal" | "hybrid";
export type ExecutionApprovalMode = "manual" | "risk_ack" | "full_auto";
export type ExecutionProfile = "local" | "docker" | "remote" | "plan_only";
export type EvidenceDepth = "shallow" | "deep";
export type NodeOptionPackageName = "fast" | "thorough" | "paper_scale";
export type ExperimentNetworkPolicy = "blocked" | "declared" | "required";
export type ExperimentNetworkPurpose =
  | "logging"
  | "artifact_upload"
  | "model_download"
  | "dataset_fetch"
  | "remote_inference"
  | "other";
export type DoctorCheckStatus = "ok" | "warn" | "warning" | "fail";

export type TransitionAction =
  | "advance"
  | "retry_same"
  | "backtrack_to_collection"
  | "backtrack_to_implement"
  | "backtrack_to_design"
  | "backtrack_to_hypotheses"
  | "delegate_successor"
  | "pause_for_human";

export interface TransitionRecommendation {
  action: TransitionAction;
  sourceNode: GraphNodeId;
  targetNode?: GraphNodeId;
  reason: string;
  confidence: number;
  autoExecutable: boolean;
  evidence: string[];
  suggestedCommands: string[];
  generatedAt: string;
}

export interface TransitionHistoryEntry {
  action: TransitionAction;
  sourceNode: GraphNodeId;
  fromNode: GraphNodeId;
  toNode?: GraphNodeId;
  reason: string;
  confidence: number;
  autoExecutable: boolean;
  appliedAt: string;
}

export interface ApprovalSignal {
  source?: "review";
  overall_score?: number;
  specialist_scores?: number[];
  summary?: string;
}

export interface NodeState {
  status: NodeStatus;
  updatedAt: string;
  note?: string;
  lastError?: string;
  approvalSignal?: ApprovalSignal;
}

export interface RetryPolicy {
  maxAttemptsPerNode: number;
  maxAutoRollbacksPerNode: number;
  /** Maximum backward jumps the minimal-approval runtime may auto-apply before pausing for human review. */
  maxAutoBackwardJumps?: number;
}

export interface NodeOptions {
  node?: GraphNodeId | "all";
  maxAttemptsPerNode: number;
  skipLLMReview: boolean;
  evidenceDepth: EvidenceDepth;
  requireBaselineComparator?: boolean;
}

export interface NodeOptionPackage {
  name: NodeOptionPackageName;
  description: string;
  nodeOverrides: Partial<NodeOptions>[];
}

export interface RunGraphState {
  currentNode: GraphNodeId;
  nodeStates: Record<GraphNodeId, NodeState>;
  retryCounters: Partial<Record<GraphNodeId, number>>;
  rollbackCounters: Partial<Record<GraphNodeId, number>>;
  researchCycle: number;
  pendingTransition?: TransitionRecommendation;
  transitionHistory: TransitionHistoryEntry[];
  lastAppliedTransition?: TransitionHistoryEntry;
  checkpointSeq: number;
  retryPolicy: RetryPolicy;
}

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed";

export interface RunUsageTotals {
  costUsd: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  wallTimeMs: number;
}

export interface NodeUsageSummary extends RunUsageTotals {
  executions: number;
  lastUpdatedAt?: string;
}

export interface RunUsageSummary {
  totals: RunUsageTotals;
  byNode: Partial<Record<GraphNodeId, NodeUsageSummary>>;
  lastUpdatedAt?: string;
}

export type RunExecutionRole = "standard" | "delegated_once";

export type RunSuccessorRelation =
  | "topic_probe_confirmatory"
  | "topic_probe_repeat"
  | "topic_probe_deferred_candidate"
  | "topic_probe_portfolio_refresh"
  | "topic_probe_evidence_repair";

export interface RunPromotionLineage {
  schemaVersion: 1;
  relation: RunSuccessorRelation;
  parentRunId: string;
  parentResearchCycle: number;
  outcomeContentSha256: string;
  receiptContentSha256: string;
}

export interface RunDelegatedSuccessorMarker {
  schemaVersion: 1;
  state: "delegated";
  relation: RunSuccessorRelation;
  parentResearchCycle: number;
  childRunId: string;
  outcomeContentSha256: string;
  receiptContentSha256: string;
  reservedAt: string;
}

export interface PaperProfileConfig {
  /** Number of columns for the main body (1 or 2). Default: 2. */
  column_count: 1 | 2;
  /** Nominal page-count target used to size word budgets and section allocations. */
  target_main_pages?: number;
  /** Minimum compiled main-body pages accepted by the page-budget validator. Defaults to target_main_pages. */
  minimum_main_pages?: number;
  /**
   * @deprecated Compatibility alias. When explicit fields are absent, this seeds both
   * target_main_pages and minimum_main_pages. Prefer the explicit fields for new configs.
   */
  main_page_limit?: number;
  references_counted: boolean;
  appendix_allowed: boolean;
  appendix_format: "double_column" | "single_column";
  prefer_appendix_for: string[];
  estimated_words_per_page?: number;
}

export interface ResolvedPaperProfileConfig extends Omit<PaperProfileConfig, "target_main_pages" | "minimum_main_pages"> {
  target_main_pages: number;
  minimum_main_pages: number;
  /**
   * @deprecated Compatibility alias for minimum_main_pages, retained so older run artifacts
   * and tests can still be interpreted during the migration.
   */
  main_page_limit: number;
}

/** Manuscript format constraints that can be specified in a research brief. */
export interface ManuscriptFormatTarget {
  /** Number of columns (1 or 2). */
  columns: 1 | 2;
  /** Target page count for the main paper body. This seeds minimum_main_pages unless overridden elsewhere. */
  main_body_pages: number;
  /** Whether the reference list is excluded from the page count. */
  references_excluded_from_page_limit: boolean;
  /** Whether appendices are excluded from the page count. */
  appendices_excluded_from_page_limit: boolean;
}

export interface RunRecord {
  version: 3;
  workflowVersion: 3;
  id: string;
  title: string;
  topic: string;
  constraints: string[];
  objectiveMetric: string;
  status: RunStatus;
  currentNode: GraphNodeId;
  latestSummary?: string;
  nodeThreads: Partial<Record<GraphNodeId, string>>;
  createdAt: string;
  updatedAt: string;
  usage?: RunUsageSummary;
  executionRole?: RunExecutionRole;
  promotionLineage?: RunPromotionLineage;
  delegatedSuccessor?: RunDelegatedSuccessorMarker;
  graph: RunGraphState;
  memoryRefs: {
    runContextPath: string;
    longTermPath: string;
    episodePath: string;
  };
}

export interface RunsFile {
  version: 3;
  runs: RunRecord[];
}

export interface AppConfig {
  version: 1;
  project_name: string;
  providers: {
    llm_mode: "codex" | "codex_chatgpt_only" | "openai_api" | "ollama";
    codex: {
      model: string;
      chat_model?: string;
      experiment_model?: string;
      text_transport?: "cli" | "oauth_responses";
      reasoning_effort: "minimal" | "low" | "medium" | "high" | "xhigh";
      chat_reasoning_effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
      experiment_reasoning_effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
      command_reasoning_effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
      fast_mode: boolean;
      chat_fast_mode?: boolean;
      experiment_fast_mode?: boolean;
      auth_required: true;
    };
    openai: {
      model: string;
      chat_model?: string;
      experiment_model?: string;
      reasoning_effort: "minimal" | "low" | "medium" | "high" | "xhigh";
      chat_reasoning_effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
      experiment_reasoning_effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
      command_reasoning_effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
      api_key_required: true;
    };
    ollama?: {
      base_url: string;
      chat_model: string;
      research_model: string;
      experiment_model?: string;
      vision_model?: string;
      chat_reasoning_effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
      research_reasoning_effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    };
  };
  papers: {
    max_results: number;
    per_second_limit: number;
  };
  research: {
    default_topic: string;
    default_constraints: string[];
    default_objective_metric: string;
  };
  workflow: {
    mode: "agent_approval";
    wizard_enabled: true;
    approval_mode?: WorkflowApprovalMode;
    execution_approval_mode?: ExecutionApprovalMode;
    budget_guard_usd?: number;
  };
  experiments: {
    runner: "local_python";
    timeout_sec: number;
    /** @deprecated Compatibility compatibility field. Network access is no longer controlled by a boolean gate. */
    allow_network?: boolean;
    network_policy?: ExperimentNetworkPolicy;
    network_purpose?: ExperimentNetworkPurpose;
    candidate_isolation?: "attempt_snapshot_restore" | "attempt_worktree";
  };
  paper: {
    template: "acl";
    build_pdf: boolean;
    latex_engine: "auto_install";
    validation_mode?: "default" | "strict_paper";
  };
  paths: {
    runs_dir: string;
    logs_dir: string;
  };
  exploration?: {
    enabled?: boolean;
    figure_auditor?: {
      enabled?: boolean;
      block_on_severe_mismatch?: boolean;
      require_caption_alignment?: boolean;
      require_reference_alignment?: boolean;
    };
  };
  /** Runtime-only environment detection. This is attached in memory and stripped before persisting config.yaml. */
  runtime?: {
    execution_profile?: ExecutionProfile;
    node_option_package?: NodeOptionPackageName;
    resolved_node_options?: NodeOptions;
    exploration_enabled?: boolean;
  };
}

export type PersistedAppConfig = Omit<
  AppConfig,
  "papers" | "research" | "workflow" | "experiments" | "paper" | "paths"
> & {
  papers?: AppConfig["papers"];
  research?: AppConfig["research"];
  workflow?: AppConfig["workflow"];
  experiments?: AppConfig["experiments"];
  paper?: Partial<AppConfig["paper"]>;
  paths?: AppConfig["paths"];
};

export interface DoctorCheck {
  name: string;
  ok: boolean;
  status?: DoctorCheckStatus;
  detail: string;
  check?: string;
  message?: string;
}

export interface SuggestionItem {
  key: string;
  label: string;
  description: string;
  applyValue: string;
}

export interface SlashContextRun {
  id: string;
  title: string;
  currentNode: GraphNodeId;
  status: RunStatus;
  updatedAt: string;
}

export interface PendingPlan {
  sourceInput: string;
  displayCommands: string[];
  stepIndex: number;
  totalSteps: number;
}

export interface RunInsightCard {
  title: string;
  lines: string[];
  readinessRisks?: {
    stage: "review" | "paper";
    readinessState: string;
    paperReady: boolean;
    riskCounts: {
      total: number;
      blocked: number;
      warning: number;
    };
    risks: Array<{
      code: string;
      section: string;
      severity: "warning" | "fail";
      message: string;
      source: "review_readiness" | "paper_readiness";
    }>;
    artifactRefs: Array<{
      label: string;
      path: string;
    }>;
  };
  manuscriptQuality?: {
    status: "pass" | "repairing" | "stopped";
    stage: "initial_gate" | "post_repair_1" | "post_repair_2";
    reasonCategory:
      | "review_reliability"
      | "policy_hard_stop"
      | "locality_violation"
      | "visual_overclaim"
      | "repeated_issue"
      | "no_improvement"
      | "scope_too_broad"
      | "upstream_scientific_or_submission_failure"
      | "clean_pass"
      | "repairable_manuscript_issue";
    displayReasonLabel?: string;
    reviewReliability: "grounded" | "partially_grounded" | "degraded";
    triggeredBy: string[];
    repairAttempts: {
      attempted: number;
      allowedMax: number;
      remaining: number;
      improvementDetected?: boolean;
    };
    issueCounts: {
      manuscript: number;
      hardStopPolicy: number;
      backstopOnly: number;
      readinessRisks?: number;
      scientificBlockers: number;
      submissionBlockers: number;
      reviewerMissedPolicy: number;
      reviewerCoveredBackstop: number;
    };
    issueGroups: {
      manuscript: Array<{
        code: string;
        section: string;
        severity: "warning" | "fail";
        message: string;
        source: "review" | "style_lint";
      }>;
      hardStopPolicy: Array<{
        code: string;
        section: string;
        severity: "warning" | "fail";
        message: string;
        source: "style_lint";
      }>;
      backstopOnly: Array<{
        code: string;
        section: string;
        severity: "warning" | "fail";
        message: string;
        source: "style_lint";
      }>;
      readiness?: Array<{
        code: string;
        section: string;
        severity: "warning" | "fail";
        message: string;
        source: "paper_readiness";
      }>;
      scientific: Array<{
        code: string;
        section: string;
        severity: "warning" | "fail";
        message: string;
        source: "scientific_validation";
      }>;
      submission: Array<{
        code: string;
        section: string;
        severity: "warning" | "fail";
        message: string;
        source: "submission_validation";
      }>;
    };
    artifactRefs: Array<{
      label: string;
      path: string;
    }>;
  };
  actions?: Array<{
    label: string;
    command: string;
  }>;
  references?: Array<{
    kind: "figure" | "comparison" | "statistics" | "transition" | "report" | "metrics";
    label: string;
    path: string;
    summary: string;
    facts?: Array<{
      label: string;
      value: string;
    }>;
    details?: string[];
  }>;
}

export type RunLifecycleStatus = RunStatus | "needs_approval";
export type RunRecommendedNextAction =
  | "inspect_blocker"
  | "resume_review"
  | "rerun_after_fix"
  | "waiting_for_input"
  | "completed";
export type RunValidationScope = "full_run" | "live_fixture";
export type RunNetworkDependencySeverity = "info" | "warning" | "attention" | "blocking";
export type RunEvidenceAdequacyStatus =
  | "unmeasured"
  | "awaiting_execution"
  | "missing_contract"
  | "missing_receipt"
  | "pass"
  | "fail"
  | "unknown"
  | "invalid";

export interface RunEvidenceAdequacyArtifactRef {
  kind: "contract" | "receipt" | "assessment" | "review_reassessment";
  label: string;
  path: string;
}

export interface RunEvidenceAdequacyProjection {
  status: RunEvidenceAdequacyStatus;
  trusted: boolean;
  integrity_valid: boolean;
  paper_evidence_allowed: boolean;
  contract_present: boolean;
  receipt_present: boolean;
  assessment_present: boolean;
  review_reassessment_present: boolean;
  primary_comparison_id?: string;
  overall_status?: "pass" | "fail" | "unknown";
  reason_codes: string[];
  artifact_refs: RunEvidenceAdequacyArtifactRef[];
}

export interface RunStatusFailureSeed {
  key: string;
  summary: string;
  remediation: string;
}

export interface RunOperatorStatusArtifact {
  version: 1;
  generated_at: string;
  run_id: string;
  research_cycle?: number;
  checkpoint_seq?: number;
  run_updated_at?: string;
  title: string;
  current_node: GraphNodeId;
  lifecycle_status: RunLifecycleStatus;
  approval_mode: WorkflowApprovalMode;
  last_event_at: string;
  analysis_ready: boolean;
  review_ready: boolean;
  paper_ready: boolean;
  recommended_next_action: RunRecommendedNextAction;
  blocker_summary?: string;
  blocking_reasons: string[];
  warning_reasons: string[];
  dominant_failure?: RunStatusFailureSeed;
  review_gate: {
    status?: "missing" | "ready" | "warning" | "blocking";
    decision_outcome?: string;
    recommended_transition?: string;
    score_overall?: number;
    operator_label?: string;
  };
  paper_gate: {
    status?: "missing" | "passed" | "warning" | "blocking";
    readiness_state?: string;
    reason?: string;
    operator_label?: string;
  };
  evidence_adequacy: RunEvidenceAdequacyProjection;
  network_dependency: {
    enabled: boolean;
    policy?: ExperimentNetworkPolicy;
    purpose?: ExperimentNetworkPurpose;
    severity: RunNetworkDependencySeverity;
    operator_label: string;
  };
  validation_scope: RunValidationScope;
}

export interface RunCompletenessChecklistArtifact {
  version: 1;
  generated_at: string;
  run_id: string;
  validation_scope: RunValidationScope;
  run_record_present: boolean;
  events_present: boolean;
  checkpoints_present: boolean;
  latest_checkpoint_present: boolean;
  public_results_mirror_present: boolean;
  node_artifact_presence: Record<string, boolean>;
  missing_required: string[];
  missing_optional: string[];
  summary: string;
}

export interface RunJobFailureAggregate {
  key: string;
  reason: string;
  occurrence_count: number;
  recurrence_probability: number;
  remediation: string;
}

export type RunResearchFunnelIntegrityStatus = "unmeasured" | "partial" | "complete" | "mismatch";

export interface RunEffectCriterionProjection {
  basis: "delta_vs_reference";
  magnitude: number;
  scale: "raw" | "proportion" | "percent" | "percentage_point";
  inclusive: boolean;
}

export interface RunResearchFunnelGateProjection {
  scope: "gap_map" | "gap_candidate" | "topic_portfolio" | "topic_candidate";
  code: string;
  status: "pass" | "block";
  message: string;
  trusted: boolean;
  candidate_id?: string;
}

export interface RunResearchFunnelDissentProjection {
  source: "portfolio_review" | "design_panel";
  candidate_id: string;
  hard_block: boolean;
  summary: string;
  findings: string[];
  trusted: boolean;
  reviewer_id?: string;
  reviewer_label?: string;
}

export interface RunLiteratureQueryProjection {
  query: string;
  source: "requested_query" | "llm_query_planner" | "deterministic_query" | "unknown";
  source_reason: string;
  reason: string;
  fallback: boolean;
  filters_relaxed: boolean;
  allocated_limit?: number;
  retrieval_limit?: number;
  fetched?: number;
  relevant_fetched?: number;
  selected?: number;
}

export type RunResearchFunnelLifecycleStage =
  | "discovery"
  | "probe_authorized"
  | "outcome_decided"
  | "followup_required"
  | "reviewed"
  | "invalid_chain";

export type RunResearchFunnelCollectionState =
  | "unmeasured"
  | "collecting"
  | "quality_gate_failed"
  | "quality_gate_exhausted"
  | "quality_gate_passed"
  | "failed";

export type RunResearchFunnelCollectionFailureClass =
  | "query_quality_failure"
  | "semantic_review_operational_failure"
  | "semantic_review_incomplete";

export type RunResearchFunnelSemanticReviewStatus =
  | "complete"
  | "partial"
  | "operational_failure";

export interface RunResearchFunnelReformulationHintProjection {
  evidence_status: "query_hint_only";
  paper_evidence_allowed: false;
  active?: boolean;
  failure_class?: RunResearchFunnelCollectionFailureClass;
  feedback_applied?: boolean;
  semantic_review_status?: RunResearchFunnelSemanticReviewStatus;
  shared_anchor_terms: string[];
  candidate_titles: string[];
  axes: Array<{
    query_family?: string;
    query?: string;
    axis_terms: string[];
    relevant_paper_count?: number;
  }>;
  artifact_ref?: { label: string; path: string };
}

export interface RunResearchFunnelOutcomeGateProjection {
  status: "unmeasured" | "decided" | "blocked_invalid_artifact_chain" | "invalid";
  trusted: boolean;
  reason_codes: string[];
  content_sha256?: string;
  artifact_ref?: { label: string; path: string };
}

export interface RunResearchFunnelFollowupHandoffProjection {
  status: "unmeasured" | "ready" | "invalid";
  trusted: boolean;
  recommended_followup_mode?: "hypothesis_test" | "topic_discovery";
  evidence_stage?: "confirmatory" | "bounded_probe" | "topic_refresh";
  content_sha256?: string;
  artifact_ref?: { label: string; path: string };
}

export interface RunResearchFunnelReviewGateProjection {
  status: "unmeasured" | "followup_required" | "blocked_invalid_artifact_chain" | "invalid";
  trusted: boolean;
  paper_drafting_allowed: false;
  reason_codes: string[];
  content_sha256?: string;
  artifact_ref?: { label: string; path: string };
}

export interface RunResearchFunnelTopicMemoryProjection {
  status: "unmeasured" | "verified" | "blocked";
  trusted: boolean;
  ledger_sha256?: string;
  record_count: number;
  blocked_candidate_count: number;
  reentry_required_count: number;
  reentry_allowed_count: number;
  audit_artifact_ref?: { label: string; path: string };
  update_artifact_ref?: { label: string; path: string };
}

export interface RunResearchFunnelCandidatePriorSearchProjection {
  status: "unmeasured" | "search_required" | "complete" | "exhausted" | "blocked";
  trusted: boolean;
  action?: "request_collection" | "already_searched" | "exhausted" | "not_required" | "blocked_invalid_lineage";
  completed_rounds: number;
  max_rounds: number;
  current_receipt_status: "unmeasured" | "not_applicable" | "valid" | "invalid";
  candidate_count: number;
  selected_candidate_count: number;
  broad_lane_attempt_count: number;
  recent_lane_attempt_count: number;
  fetched_count: number;
  selected_paper_count: number;
  covered_candidate_ids: string[];
  plan_sha256?: string;
  receipt_sha256?: string;
  reason_codes: string[];
  artifact_refs: Array<{ label: string; path: string }>;
}

export interface RunTopicProbeExecutionAuthorizationProjection {
  status: "unmeasured" | "pending" | "authorized" | "blocked" | "invalid";
  trusted: boolean;
  authorized: boolean;
  base_funnel_authorized: boolean;
  candidate_prior_search_authorized: boolean;
  estimator_authorized: boolean;
  required_candidate_ids: string[];
  covered_candidate_ids: string[];
  reason_codes: string[];
}

export interface RunResearchFunnelEstimatorFeasibilityProjection {
  status: "unmeasured" | "pass" | "blocked" | "invalid";
  trusted: boolean;
  execution_authorized: boolean;
  estimand_type?: string;
  estimator_family?: string;
  independent_cluster_count?: number;
  primary_denominator?: number;
  attainable_resolution?: number;
  planned_minimum_detectable_effect?: number;
  computed_minimum_detectable_effect?: number;
  reason_codes: string[];
  artifact_refs: Array<{ label: string; path: string }>;
}

export interface RunResearchFunnelCandidateProjection {
  rank: number;
  candidate_id: string;
  topic_id: string;
  statement: string;
  trusted: boolean;
  review_status: "kept" | "rejected" | "not_reviewed";
  probe_status: "shortlisted" | "not_shortlisted";
  probe_eligible: boolean;
  scores: {
    novelty: number;
    feasibility: number;
    testability: number;
    cost: number;
    expected_gain: number;
  };
  closest_prior_paper_ids: string[];
  closest_prior_full_text_paper_ids: string[];
  prior_absorption_comparisons: Array<{
    prior_paper_id: string;
    disposition: "absorbed" | "partially_absorbed" | "non_overlapping" | "uncertain";
  }>;
  prior_absorption_reason_codes: string[];
  closest_prior_non_overlap?: string;
  reviewer_absorption_objection?: string;
  comparator?: string;
  dataset_task_bench?: string;
  primary_metric?: string;
  local_budget?: string;
  kill_signal?: string;
  contribution_claim?: string;
  minimum_publishable_evidence?: string;
  review_summary?: string;
  topic_memory_disposition?:
    | "clear"
    | "blocked"
    | "requires_reentry_adjudication"
    | "reentry_allowed";
  topic_memory_maximum_lineage_similarity?: number;
  blocked_gate_codes: string[];
}

export interface RunResearchFunnelProjection {
  research_mode: "topic_discovery";
  lifecycle_stage: RunResearchFunnelLifecycleStage;
  bounded_probe_paper_evidence_allowed: false;
  collection_state: RunResearchFunnelCollectionState;
  collection_node_attempt?: number;
  collection_node_max_attempts?: number;
  query_plan_attempt?: number;
  collection_quality_failure_reasons: string[];
  collection_reformulation_hint?: RunResearchFunnelReformulationHintProjection;
  gap_evidence_audit?: {
    status: "unmeasured" | "verified" | "blocked";
    construction_mode?: "legacy_exact_grouping" | "reviewed_semantic_synthesis" | "deterministic_safe_fallback" | "deferred_partial_analysis";
    synthesis_status?: "completed" | "safe_fallback";
    analysis_coverage?: {
      selected_paper_count: number;
      completed_paper_count: number;
      failed_paper_ids: string[];
      complete: boolean;
    };
    total_evidence_count: number;
    scientific_evidence_count: number;
    grounded_scientific_evidence_count: number;
    synthesis_eligible_evidence_count: number;
    synthesis_excluded_evidence_count: number;
    accepted_cluster_count: number;
    malformed_evidence_row_count: number;
    source_scope_counts: Record<"abstract" | "full_text_excerpt" | "full_document" | "unknown", number>;
    grounding_status_counts: Record<"grounded_span" | "ungrounded_span" | "fallback" | "unknown", number>;
  };
  candidate_count: number;
  cluster_count: number;
  candidate_prior_search: RunResearchFunnelCandidatePriorSearchProjection;
  estimator_feasibility: RunResearchFunnelEstimatorFeasibilityProjection;
  topic_memory: RunResearchFunnelTopicMemoryProjection;
  diagnostics_trusted: boolean;
  authorization_trusted: boolean;
  portfolio_candidates: RunResearchFunnelCandidateProjection[];
  probe_candidate_count: number;
  probe_candidate_ids: string[];
  probe_candidate_statements: string[];
  active_candidate_id?: string;
  active_topic_id?: string;
  active_candidate_hash?: string;
  active_primary_metric?: string;
  active_metric_unit?: string;
  active_metric_scale?: "raw" | "proportion" | "percent" | "percentage_point";
  active_metric_direction?: "maximize" | "minimize";
  active_effect_criterion?: RunEffectCriterionProjection;
  active_objective_raw?: string;
  active_meaningful_effect?: string;
  active_evidence_stage?: "bounded_probe";
  active_deferred_candidate_ids?: string[];
  authorization_disposition: "probe_authorized" | "backtrack_to_hypotheses" | "unmeasured";
  authorization_probe_allowed: boolean;
  effective_execution_authorized: boolean;
  execution_authorization: RunTopicProbeExecutionAuthorizationProjection;
  outcome_disposition?: "promote_to_confirmatory" | "reject_candidate" | "repeat_probe" | "blocked_invalid_evidence";
  outcome_next_action?: "start_confirmatory_run" | "try_deferred_candidate" | "refresh_topic_portfolio" | "repeat_bounded_probe" | "repair_probe_evidence";
  outcome_gate: RunResearchFunnelOutcomeGateProjection;
  followup_handoff: RunResearchFunnelFollowupHandoffProjection;
  review_gate: RunResearchFunnelReviewGateProjection;
  invalid_chain_blockers: string[];
  reason_codes: string[];
  gates: RunResearchFunnelGateProjection[];
  dissent: RunResearchFunnelDissentProjection[];
  literature_queries: RunLiteratureQueryProjection[];
  query_fallback_used: boolean;
  query_fallback_reasons: string[];
  hashes: {
    gap_map?: string;
    topic_portfolio?: string;
    topic_decision?: string;
    active_topic_probe_contract?: string;
    topic_probe_outcome?: string;
    topic_probe_outcome_gate?: string;
    topic_probe_followup_handoff?: string;
    topic_probe_review_gate?: string;
  };
  artifact_refs: Array<{
    label: string;
    path: string;
  }>;
  integrity_status: RunResearchFunnelIntegrityStatus;
}

export interface RunEvidenceReadinessProjection {
  status: "unmeasured" | "missing" | "available" | "invalid";
  evidence_ready: boolean;
  trusted: boolean;
  comparison_count: number;
  primary_comparison_id?: string;
  warnings: string[];
  artifact_ref?: {
    label: string;
    path: string;
  };
}

export interface RunJobProjection {
  run_id: string;
  title: string;
  current_node: GraphNodeId;
  lifecycle_status: RunLifecycleStatus;
  approval_mode: WorkflowApprovalMode;
  last_event_at: string;
  recommended_next_action: RunRecommendedNextAction;
  analysis_ready: boolean;
  review_ready: boolean;
  paper_ready: boolean;
  review_gate_status?: "missing" | "ready" | "warning" | "blocking";
  review_decision_outcome?: string;
  review_recommended_transition?: string;
  review_score_overall?: number;
  paper_readiness_state?: string;
  paper_readiness_reason?: string;
  blocker_summary?: string;
  review_gate_label?: string;
  paper_gate_label?: string;
  blocking_reasons?: string[];
  warning_reasons?: string[];
  network_dependency?: RunOperatorStatusArtifact["network_dependency"];
  validation_scope?: RunValidationScope;
  research_funnel?: RunResearchFunnelProjection;
  evidence_readiness?: RunEvidenceReadinessProjection;
  evidence_adequacy?: RunEvidenceAdequacyProjection;
}

export interface RunJobsSnapshot {
  generated_at: string;
  runs: RunJobProjection[];
  top_failures: RunJobFailureAggregate[];
}

export type RunQueueRecommendedAction = "retry" | "manual review";

export interface RunQueueJobSummary {
  run_id: string;
  node: GraphNodeId;
  status: string;
  started_at: string;
  elapsed_seconds: number;
  recommended_action?: RunQueueRecommendedAction;
  recommendation_line?: string;
  source?: "run" | "collect_background_job";
}

export interface RunQueueSnapshot {
  running: RunQueueJobSummary[];
  waiting: RunQueueJobSummary[];
  stalled: RunQueueJobSummary[];
}

export interface WebSessionState {
  activeRunId?: string;
  busy: boolean;
  busyLabel?: string;
  pendingPlan?: PendingPlan;
  logs: string[];
  canCancel: boolean;
  activeRunInsight?: RunInsightCard;
}

export interface ArtifactEntry {
  path: string;
  kind: "directory" | "text" | "json" | "image" | "pdf" | "download";
  size: number;
  modifiedAt: string;
  previewable: boolean;
}
