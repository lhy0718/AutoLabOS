export type NodeId =
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

export type ExecutionProfile = "local" | "docker" | "remote" | "plan_only";

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

export type RunLifecycleStatus = "pending" | "running" | "paused" | "completed" | "failed" | "needs_approval";
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
  title: string;
  current_node: NodeId;
  lifecycle_status: RunLifecycleStatus;
  approval_mode: "manual" | "minimal" | "hybrid";
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
    policy?: "blocked" | "declared" | "required";
    purpose?: "logging" | "artifact_upload" | "model_download" | "dataset_fetch" | "remote_inference" | "other";
    severity: RunNetworkDependencySeverity;
    operator_label: string;
  };
  validation_scope: RunValidationScope;
}

export interface RunJobFailureAggregate {
  key: string;
  reason: string;
  occurrence_count: number;
  recurrence_probability: number;
  remediation: string;
}

export interface ResearchFunnelProjection {
  research_mode: "topic_discovery";
  lifecycle_stage:
    | "discovery"
    | "probe_authorized"
    | "outcome_decided"
    | "followup_required"
    | "reviewed"
    | "invalid_chain";
  bounded_probe_paper_evidence_allowed: false;
  collection_state:
    | "unmeasured"
    | "collecting"
    | "quality_gate_failed"
    | "quality_gate_exhausted"
    | "quality_gate_passed"
    | "failed";
  collection_node_attempt?: number;
  collection_node_max_attempts?: number;
  query_plan_attempt?: number;
  collection_quality_failure_reasons: string[];
  collection_reformulation_hint?: {
    evidence_status: "query_hint_only";
    paper_evidence_allowed: false;
    shared_anchor_terms: string[];
    candidate_titles: string[];
    axes: Array<{
      query_family?: string;
      query?: string;
      axis_terms: string[];
      relevant_paper_count?: number;
    }>;
    artifact_ref?: { label: string; path: string };
  };
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
  candidate_prior_search: {
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
  };
  estimator_feasibility: {
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
  };
  topic_memory: {
    status: "unmeasured" | "verified" | "blocked";
    trusted: boolean;
    ledger_sha256?: string;
    record_count: number;
    blocked_candidate_count: number;
    reentry_required_count: number;
    reentry_allowed_count: number;
    audit_artifact_ref?: { label: string; path: string };
    update_artifact_ref?: { label: string; path: string };
  };
  diagnostics_trusted: boolean;
  authorization_trusted: boolean;
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
  active_effect_criterion?: {
    basis: "delta_vs_reference";
    magnitude: number;
    scale: "raw" | "proportion" | "percent" | "percentage_point";
    inclusive: boolean;
  };
  active_objective_raw?: string;
  active_meaningful_effect?: string;
  active_evidence_stage?: "bounded_probe";
  active_deferred_candidate_ids?: string[];
  authorization_disposition: "probe_authorized" | "backtrack_to_hypotheses" | "unmeasured";
  authorization_probe_allowed: boolean;
  effective_execution_authorized: boolean;
  execution_authorization: {
    status: "unmeasured" | "pending" | "authorized" | "blocked" | "invalid";
    trusted: boolean;
    authorized: boolean;
    base_funnel_authorized: boolean;
    candidate_prior_search_authorized: boolean;
    estimator_authorized: boolean;
    required_candidate_ids: string[];
    covered_candidate_ids: string[];
    reason_codes: string[];
  };
  outcome_disposition?: "promote_to_confirmatory" | "reject_candidate" | "repeat_probe" | "blocked_invalid_evidence";
  outcome_next_action?: "start_confirmatory_run" | "try_deferred_candidate" | "refresh_topic_portfolio" | "repeat_bounded_probe" | "repair_probe_evidence";
  outcome_gate: {
    status: "unmeasured" | "decided" | "blocked_invalid_artifact_chain" | "invalid";
    trusted: boolean;
    reason_codes: string[];
    content_sha256?: string;
    artifact_ref?: { label: string; path: string };
  };
  followup_handoff: {
    status: "unmeasured" | "ready" | "invalid";
    trusted: boolean;
    recommended_followup_mode?: "hypothesis_test" | "topic_discovery";
    evidence_stage?: "confirmatory" | "bounded_probe" | "topic_refresh";
    content_sha256?: string;
    artifact_ref?: { label: string; path: string };
  };
  review_gate: {
    status: "unmeasured" | "followup_required" | "blocked_invalid_artifact_chain" | "invalid";
    trusted: boolean;
    paper_drafting_allowed: false;
    reason_codes: string[];
    content_sha256?: string;
    artifact_ref?: { label: string; path: string };
  };
  invalid_chain_blockers: string[];
  reason_codes: string[];
  gates: Array<{
    scope: "gap_map" | "gap_candidate" | "topic_portfolio" | "topic_candidate";
    code: string;
    status: "pass" | "block";
    message: string;
    trusted: boolean;
    candidate_id?: string;
  }>;
  dissent: Array<{
    source: "portfolio_review" | "design_panel";
    candidate_id: string;
    hard_block: boolean;
    summary: string;
    findings: string[];
    trusted: boolean;
    reviewer_id?: string;
    reviewer_label?: string;
  }>;
  literature_queries: Array<{
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
  }>;
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
  integrity_status: "unmeasured" | "partial" | "complete" | "mismatch";
}

export interface EvidenceReadinessProjection {
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
  current_node: NodeId;
  lifecycle_status: RunLifecycleStatus;
  approval_mode: "manual" | "minimal" | "hybrid";
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
  research_funnel?: ResearchFunnelProjection;
  evidence_readiness?: EvidenceReadinessProjection;
  evidence_adequacy?: RunEvidenceAdequacyProjection;
}

export interface RunJobsSnapshot {
  generated_at: string;
  runs: RunJobProjection[];
  top_failures: RunJobFailureAggregate[];
}

export interface RunQueueJobSummary {
  run_id: string;
  node: NodeId;
  status: string;
  started_at: string;
  elapsed_seconds: number;
  recommended_action?: "retry" | "manual review";
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

export interface ExplorationStatusResponse {
  enabled: boolean;
  current_stage: "feasibility" | "baseline_hardening" | "main_agenda" | "ablation" | null;
  node_counts: {
    explored: number;
    promoted: number;
    blocked: number;
  } | null;
  hypothesis_usage: Record<string, { total: number; promoted: number }> | null;
  best_defensible_branch_id: string | null;
  rollback_reason: string | null;
  baseline_lock_status: "locked" | "not_locked" | "not_applicable";
  evidence_completeness: number | null;
  figure_audit_warnings: number | null;
  severe_figure_mismatch: boolean | null;
}

export interface RunRecord {
  id: string;
  title: string;
  topic: string;
  constraints: string[];
  objectiveMetric: string;
  status: string;
  currentNode: NodeId;
  latestSummary?: string;
  updatedAt: string;
  graph: {
    currentNode: NodeId;
    checkpointSeq: number;
    retryCounters: Partial<Record<NodeId, number>>;
    rollbackCounters: Partial<Record<NodeId, number>>;
    nodeStates: Record<
      NodeId,
      {
        status: string;
        updatedAt: string;
        note?: string;
        lastError?: string;
      }
    >;
    pendingTransition?: {
      action: string;
      targetNode?: NodeId;
      reason: string;
      confidence: number;
      autoExecutable: boolean;
      evidence: string[];
      suggestedCommands: string[];
      generatedAt: string;
    };
    transitionHistory?: Array<{
      action: string;
      sourceNode: NodeId;
      fromNode: NodeId;
      toNode?: NodeId;
      reason: string;
      confidence: number;
      autoExecutable: boolean;
      appliedAt: string;
    }>;
    lastAppliedTransition?: {
      action: string;
      sourceNode: NodeId;
      fromNode: NodeId;
      toNode?: NodeId;
      reason: string;
      confidence: number;
      autoExecutable: boolean;
      appliedAt: string;
    };
  };
}

export interface ResearchBriefStartGate {
  requested: boolean;
  canStart: boolean;
  blocked: boolean;
  effectiveAutoStart: boolean;
  missingFields: string[];
  validationErrors: string[];
  validationWarnings: string[];
}

export interface WebRunCreationResponse {
  run: RunRecord;
  session: WebSessionState;
  runs: RunRecord[];
  briefStartGate: ResearchBriefStartGate;
}

export interface ConfigSummary {
  projectName: string;
  workflowMode: "agent_approval";
  approvalMode: "manual" | "minimal" | "hybrid";
  executionApprovalMode?: "manual" | "risk_ack" | "full_auto";
  llmMode: "codex_chatgpt_only" | "openai_api" | "ollama";
  pdfMode: "codex_text_image_hybrid" | "responses_api_pdf" | "ollama_vision";
  researchBackendModel: string;
  chatModel: string;
  experimentModel: string;
  researchBackendReasoning: string | undefined;
  chatReasoning: string | undefined;
  experimentReasoning: string | undefined;
  networkPolicy?: "blocked" | "declared" | "required";
  networkPurpose?: "logging" | "artifact_upload" | "model_download" | "dataset_fetch" | "remote_inference" | "other";
}

export interface WebConfigFormData {
  projectName: string;
  defaultTopic: string;
  defaultConstraints: string;
  defaultObjectiveMetric: string;
  llmMode: "codex_chatgpt_only" | "openai_api" | "ollama";
  codexChatModelChoice: string;
  codexChatReasoningEffort: string;
  codexResearchBackendModelChoice: string;
  codexResearchBackendReasoningEffort: string;
  codexExperimentModelChoice: string;
  codexExperimentReasoningEffort: string;
  openAiChatModel: string;
  openAiChatReasoningEffort: string;
  openAiResearchBackendModel: string;
  openAiResearchBackendReasoningEffort: string;
  openAiExperimentModel: string;
  openAiExperimentReasoningEffort: string;
  ollamaBaseUrl: string;
  ollamaChatModel: string;
  ollamaResearchModel: string;
  ollamaExperimentModel: string;
  ollamaVisionModel: string;
  networkPolicy: "blocked" | "declared" | "required";
  networkPurpose: "" | "logging" | "artifact_upload" | "model_download" | "dataset_fetch" | "remote_inference" | "other";
}

export interface WebConfigOptions {
  codexModels: string[];
  codexReasoningByModel: Record<string, string[]>;
  openAiModels: string[];
  openAiReasoningByModel: Record<string, string[]>;
  ollamaChatModels: string[];
  ollamaResearchModels: string[];
  ollamaExperimentModels: string[];
  ollamaVisionModels: string[];
}

export interface ArtifactEntry {
  path: string;
  kind: "directory" | "text" | "json" | "image" | "pdf" | "download";
  size: number;
  modifiedAt: string;
  previewable: boolean;
}

export interface CheckpointEntry {
  seq: number;
  node: NodeId;
  phase: string;
  createdAt: string;
  reason?: string;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  status?: "ok" | "warn" | "warning" | "fail";
  detail: string;
  check?: string;
  message?: string;
}

export type HarnessIssueKind =
  | "missing_artifact"
  | "malformed_issue"
  | "broken_evidence_link"
  | "status_artifact_mismatch"
  | "paper_result_mismatch";

export type HarnessValidationScope = "issue_log" | "workspace" | "test_records";

export interface HarnessValidationFinding {
  code: string;
  message: string;
  filePath?: string;
  runId?: string;
  kind: HarnessIssueKind;
  remediation: string;
  scope: HarnessValidationScope;
  runStorePath?: string;
}

export interface HarnessValidationTargetSummary {
  scope: "workspace" | "test_records";
  runStoreCount: number;
  runCount: number;
  findingCount: number;
}

export interface HarnessValidationReport {
  generatedAt: string;
  workspaceRoot: string;
  issueLogPath: string;
  issueEntryCount: number;
  runStoresChecked: number;
  runsChecked: number;
  findings: HarnessValidationFinding[];
  countsByKind: Record<HarnessIssueKind, number>;
  targets: HarnessValidationTargetSummary[];
  status: "ok" | "fail";
}

export interface DoctorResponse {
  configured: boolean;
  status: "ok" | "warn" | "fail";
  checks: DoctorCheck[];
  harness?: HarnessValidationReport;
  readiness?: {
    blocked: boolean;
    llmMode?: "codex_chatgpt_only" | "openai_api" | "ollama";
    pdfAnalysisMode?: "codex_text_image_hybrid" | "responses_api_pdf" | "ollama_vision";
    approvalMode: "manual" | "minimal" | "hybrid";
    executionApprovalMode: "manual" | "risk_ack" | "full_auto";
    dependencyMode: "local" | "docker" | "remote_gpu" | "plan_only";
    sessionMode: "fresh" | "existing";
    candidateIsolation?: "attempt_snapshot_restore" | "attempt_worktree";
    networkPolicy?: "blocked" | "declared" | "required";
    networkPurpose?: "logging" | "artifact_upload" | "model_download" | "dataset_fetch" | "remote_inference" | "other";
    networkDeclarationPresent: boolean;
    networkApprovalSatisfied: boolean;
    warningChecks: string[];
    failedChecks: string[];
  };
}

export interface RepositoryKnowledgeSectionEntry {
  name: string;
  generated_files: string[];
  updated_at: string;
}

export interface RepositoryKnowledgeEntry {
  run_id: string;
  title: string;
  topic: string;
  topic_slug?: string;
  objective_metric: string;
  latest_summary?: string;
  latest_published_section: string;
  updated_at: string;
  public_output_root: string;
  public_manifest: string;
  knowledge_note: string;
  entry_kind?: "published_outputs" | "completed_run";
  final_node?: string;
  final_status?: string;
  paper_ready?: boolean;
  review_decision?: string;
  key_metrics?: string[];
  research_question?: string;
  analysis_summary?: string;
  manuscript_type?: string;
  sections: RepositoryKnowledgeSectionEntry[];
}

export interface KnowledgeResponse {
  version: 1;
  updated_at: string;
  entries: RepositoryKnowledgeEntry[];
}

export interface KnowledgeFileResponse {
  path: string;
  content: string;
}

export interface RunLiteratureIndex {
  version: 1;
  run_id: string;
  updated_at: string;
  corpus: {
    paper_count: number;
    papers_with_pdf: number;
    missing_pdf_count: number;
    papers_with_bibtex: number;
    enriched_bibtex_count: number;
    top_venues: string[];
    year_range?: {
      min: number;
      max: number;
    };
  };
  citations: {
    total: number;
    average: number;
    top_paper?: {
      title: string;
      citation_count: number;
    };
  };
  enrichment: {
    bibtex_mode?: string;
    pdf_recovered: number;
    bibtex_enriched: number;
    status?: string;
    last_error?: string;
  };
  analysis: {
    summary_count: number;
    evidence_count: number;
    covered_paper_count: number;
    full_text_summary_count: number;
    abstract_summary_count: number;
  };
  artifacts: {
    literature_index_path: string;
    corpus_path: string;
    bibtex_path: string;
    collect_result_path: string;
    summaries_path: string;
    evidence_path: string;
  };
  warnings: string[];
}

export interface LiteratureResponse {
  literature: RunLiteratureIndex;
}

export interface BootstrapResponse {
  configured: boolean;
  execution_profile?: ExecutionProfile;
  setupDefaults: {
    projectName: string;
    defaultTopic: string;
    defaultConstraints: string[];
    defaultObjectiveMetric: string;
  };
  session: WebSessionState;
  runs: RunRecord[];
  jobs?: RunJobsSnapshot;
  jobQueue?: RunQueueSnapshot;
  activeRunId?: string;
  configSummary?: ConfigSummary;
  configForm?: WebConfigFormData;
  configOptions?: WebConfigOptions;
}
