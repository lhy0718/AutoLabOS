import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import YAML from "yaml";

import { EventStream } from "../events.js";
import { LLMClient } from "../llm/client.js";
import { RunStore } from "../runs/runStore.js";
import { AppConfig, RunRecord } from "../../types.js";
import { CodexEvent, CodexNativeClient, RunTurnResult } from "../../integrations/codex/codexCliClient.js";
import { mapCodexEventToAutoLabOSEvents } from "../../integrations/codex/codexEventMapper.js";
import { RunContextMemory } from "../memory/runContextMemory.js";
import { EpisodeMemory, EpisodeRecord } from "../memory/episodeMemory.js";
import { LongTermEntry, LongTermStore } from "../memory/longTermStore.js";
import { ensureDir, fileExists, normalizeFsPath, writeJsonFile } from "../../utils/fs.js";
import { safeRead } from "../nodes/helpers.js";
import { buildPublicExperimentDir } from "../publicArtifacts.js";
import { publishPublicRunOutputs } from "../publicOutputPublisher.js";
import { resolveExperimentLlmProfile } from "../experimentLlmProfile.js";
import {
  ExperimentDesignImplementationValidationReport,
  PlannedConditionImplementationContract,
  validateDesignImplementationAlignment,
  validateVerificationCommandSurface
} from "../experiments/designImplementationValidator.js";
import { buildIntermediateArtifactCaptureManifest } from "../artifacts/intermediateArtifactCapture.js";
import { RunVerifierReport } from "../experiments/runVerifierFeedback.js";
import { detectLongRunningPythonBudgetGuardFailure } from "../experiments/pythonRunnerBudgetGuard.js";
import { detectPrimaryEvidenceIntegrityViolation } from "../experiments/primaryEvidenceIntegrity.js";
import { buildErrorFingerprint } from "../experiments/failureMemory.js";
import { AgentComputerInterface, AciObservation } from "../../tools/aci.js";
import {
  ExperimentComparisonContract,
  buildExperimentImplementationContext,
  CandidateIsolationAttemptReport,
  CandidateIsolationReport,
  EXPERIMENT_GOVERNANCE_DESIGN_IMPLEMENTATION_VALIDATION_KEY,
  EXPERIMENT_GOVERNANCE_IMPLEMENTATION_CONTEXT_KEY,
  loadExperimentComparisonContract,
  storeExperimentGovernanceDecision
} from "../experimentGovernance.js";
import {
  ImplementationLocalizer,
  LocalizationCandidate,
  LocalizationResult,
  LocalizationSearchHit
} from "./implementationLocalizer.js";
import { EnvironmentSnapshot } from "../environmentSnapshot.js";
import {
  buildDynamicDecompositionPlan,
  DynamicDecompositionPlan,
  DynamicDecompositionUnit,
  parseDynamicDecompositionPlan
} from "../decompositionPlan.js";
import {
  validateActiveTopicProbeContract
} from "../activeTopicProbeContract.js";
import {
  buildTopicProbeComputeBudgetContract,
  type TopicProbeComputeStage,
  type TopicProbeComputeStageLimit
} from "../topicProbeComputeBudget.js";
import {
  loadResearchBriefSnapshot,
  resolveResearchRunModeGuard
} from "../runs/researchRunModeGuard.js";
import { resolveTopicProbeComputeContractSource } from "../topicProbeComputeContractSource.js";
import {
  validatePersistedEstimatorFeasibilityGate,
  type PersistedEstimatorFeasibilityGate
} from "../estimatorFeasibilityGate.js";
import {
  loadTopicProbeExecutionAuthorizationGate,
  type TopicProbeExecutionAuthorizationGateArtifact
} from "../runs/topicProbeExecutionAuthorizationGate.js";

export interface ImplementSessionSummary {
  summary: string;
  threadId?: string;
  runCommand: string;
  testCommand?: string;
  scriptPath?: string;
  metricsPath: string;
  workingDir: string;
  experimentMode: string;
  publicDir: string;
  changedFiles: string[];
  artifacts: string[];
  publicArtifacts: string[];
  rawResponse: string;
  verifyReport: VerifyReport;
  autoHandoffToRunExperiments: boolean;
  handoffReason?: string;
  requestedGpuCount?: number;
}

export class ImplementSessionStopError extends Error {
  constructor(
    message: string,
    readonly failureKind?: "retryable" | "gate_blocked" | "environment",
    readonly toolCallsUsed = 1
  ) {
    super(message);
    this.name = "ImplementSessionStopError";
  }
}

const IMPLEMENT_DELTA_PROGRESS_MIN_CHARS = 4_000;
const IMPLEMENT_DELTA_PROGRESS_MIN_MS = 5_000;
const IMPLEMENT_STAGED_LLM_CHUNK_TARGET_CHARS = 5_000;
const IMPLEMENT_STAGED_LLM_RETRY_CHUNK_TARGET_CHARS = 2_500;
const MAX_PROVIDER_PYTHON_RUNNER_CHUNKS = 6;
const IMPLEMENT_STAGED_LLM_CHUNK_MAX_STREAMED_CHARS = 12_000;
const IMPLEMENT_STAGED_LLM_TRANSIENT_RETRY_MAX_ATTEMPTS = 12;
const IMPLEMENT_STAGED_LLM_TRANSIENT_RETRY_DELAY_MS = 5_000;

const TOPIC_PROBE_COMPUTE_USAGE_SCHEMA: ImplementTopicProbeComputeContract["compute_usage_schema"] = {
  type: "object",
  additionalProperties: false,
  required: [
    "schema_version",
    "execution_kind",
    "actual_gpu_count",
    "fresh_executed_trials",
    "cached_trials"
  ],
  properties: {
    schema_version: { const: 1 },
    execution_kind: {
      enum: ["gpu_execution", "cpu_execution", "cache_hit"]
    },
    actual_gpu_count: { type: "integer", minimum: 0 },
    fresh_executed_trials: { type: "integer", minimum: 0 },
    cached_trials: { type: "integer", minimum: 0 }
  },
  oneOf: [
    {
      properties: {
        execution_kind: { const: "gpu_execution" },
        actual_gpu_count: { type: "integer", minimum: 1 },
        fresh_executed_trials: { type: "integer", minimum: 1 }
      }
    },
    {
      properties: {
        execution_kind: { const: "cpu_execution" },
        actual_gpu_count: { const: 0 },
        fresh_executed_trials: { type: "integer", minimum: 1 }
      }
    },
    {
      properties: {
        execution_kind: { const: "cache_hit" },
        actual_gpu_count: { const: 0 },
        fresh_executed_trials: { const: 0 },
        cached_trials: { type: "integer", minimum: 1 }
      }
    }
  ]
};

interface ImplementSessionDeps {
  config: AppConfig;
  codex: CodexNativeClient;
  llm?: LLMClient;
  aci: AgentComputerInterface;
  eventStream: EventStream;
  runStore: RunStore;
  workspaceRoot: string;
}

interface StructuredImplementFileEdit {
  path: string;
  content: string;
}

interface DynamicMaterializationChunk {
  id: string;
  title: string;
  purpose: string;
  content_kind: "code_section" | "config_block" | "documentation_section" | "text_section";
  include_imports?: boolean;
  include_entrypoint?: boolean;
  depends_on?: string[];
  verification_focus?: string[];
}

interface DynamicMaterializationPlan {
  strategy?: string;
  rationale?: string;
  chunks: DynamicMaterializationChunk[];
}

interface PlannedMaterializationSection {
  section: DynamicMaterializationChunk;
  parentChunk?: DynamicMaterializationChunk;
  chunkSubdivisionPlan?: DynamicMaterializationPlan;
  chunkIndex: number;
  chunkTotal: number;
  chunkLabel: string;
}

interface StagedLlmResumeManifest {
  status?: string;
  reason?: string;
  node?: string;
  plan_hash?: string;
  completed_sections?: string[];
  completed_chunk_responses?: string[];
  incomplete_or_failed_artifacts?: string[];
  incomplete_or_failed_artifact_count?: number;
  next_unfinished_artifact?: string;
  next_unfinished_section_id?: string;
  next_unfinished_prompt?: string;
  latest_progress_index?: number;
}

interface StructuredImplementResponse {
  summary?: string;
  run_command?: string;
  test_command?: string;
  working_dir?: string;
  experiment_mode?: string;
  changed_files?: string[];
  artifacts?: string[];
  public_dir?: string;
  public_artifacts?: string[];
  script_path?: string;
  metrics_path?: string;
  requested_gpu_count?: number;
  localization?: unknown;
  assumptions?: string[];
  decomposition_plan?: DynamicDecompositionPlan;
  file_plan?: string[];
  file_edits?: StructuredImplementFileEdit[];
}

interface ImplementBootstrapRequirement {
  id: string;
  kind: "model" | "tokenizer" | "dataset" | "binary" | "library" | "reference_data" | "service";
  source: "huggingface" | "local" | "python" | "system" | "other";
  required_for: string[];
  local_path?: string;
  availability?: "assumed_local" | "download_required" | "unknown";
  summary?: string;
  remediation?: string;
}

interface ImplementBootstrapCheck {
  id: string;
  check_type: "path_exists" | "command_available" | "python_module_available";
  target: string;
  reason: string;
}

interface ImplementBootstrapContract {
  version: number;
  strategy?: string;
  summary?: string;
  requires_network?: boolean;
  requires_warm_cache?: boolean;
  blocking_reason?: string;
  remediation?: string[];
  repair_context?: {
    failure_code?: string;
    repair_target?: string;
  };
  requirements: ImplementBootstrapRequirement[];
  checks: ImplementBootstrapCheck[];
}

interface ImplementDependencyRepairContext {
  failure_code?: string;
  repair_target?: string;
  recommended_backtrack_node?: string;
  upstream_repair_hint?: string;
  operator_action_required?: boolean;
  retry_directives: string[];
}

interface ParsedStructuredImplementResponse {
  value: StructuredImplementResponse;
  isStructured: boolean;
}

interface CachedConstraintProfile {
  profile?: {
    source?: string;
    collect?: Record<string, unknown>;
    writing?: Record<string, unknown>;
    experiment?: Record<string, unknown>;
    assumptions?: string[];
  };
}

const MAX_IMPLEMENT_ATTEMPTS = 3;
const SEARCH_BRANCH_FOCUS_LIMIT = 1;
const IMPLEMENT_PROGRESS_STATUS_ARTIFACT = path.join("implement_experiments", "status.json");
const IMPLEMENT_PROGRESS_LOG_ARTIFACT = path.join("implement_experiments", "progress.jsonl");
const IMPLEMENT_PARTIAL_RESPONSE_ARTIFACT = path.join("implement_experiments", "partial_response.txt");
const IMPLEMENT_SCAFFOLD_ARTIFACT = path.join("implement_experiments", "scaffold.json");
const IMPLEMENT_SCAFFOLD_PROMPT_ARTIFACT = path.join("implement_experiments", "scaffold_prompt.txt");
const IMPLEMENT_SCAFFOLD_RAW_RESPONSE_ARTIFACT = path.join("implement_experiments", "scaffold_raw_response.txt");
const IMPLEMENT_DECOMPOSITION_PLAN_ARTIFACT = path.join("implement_experiments", "decomposition_plan.json");
const IMPLEMENT_DECOMPOSITION_PLAN_RAW_RESPONSE_ARTIFACT = path.join(
  "implement_experiments",
  "decomposition_plan_raw_response.txt"
);
const IMPLEMENT_BOOTSTRAP_CONTRACT_ARTIFACT = path.join("implement_experiments", "bootstrap_contract.json");
const IMPLEMENT_BOOTSTRAP_CONTRACT_PROMPT_ARTIFACT = path.join(
  "implement_experiments",
  "bootstrap_contract_prompt.txt"
);
const IMPLEMENT_BOOTSTRAP_CONTRACT_RAW_RESPONSE_ARTIFACT = path.join(
  "implement_experiments",
  "bootstrap_contract_raw_response.txt"
);
const IMPLEMENT_FILE_PLAN_ARTIFACT = path.join("implement_experiments", "file_plan.json");
const IMPLEMENT_UNIT_PLAN_DIR = path.join("implement_experiments", "unit_plans");
const IMPLEMENT_UNIT_SECTION_DIR = path.join("implement_experiments", "unit_sections");
const IMPLEMENT_UNIT_SKELETON_DIR = path.join("implement_experiments", "unit_skeletons");
const IMPLEMENT_UNIT_CHUNK_PROMPT_DIR = path.join("implement_experiments", "unit_chunk_prompts");
const IMPLEMENT_UNIT_CHUNK_RESPONSE_DIR = path.join("implement_experiments", "unit_chunk_responses");
const IMPLEMENT_STAGED_LLM_RESUME_MANIFEST_ARTIFACT = path.join("implement_experiments", "staged_llm_resume_manifest.json");
const MAX_DYNAMIC_CHUNK_SUBDIVISION_DEPTH = 3;
const NON_RESTORABLE_RUN_DIR_ENTRIES = new Set([
  "analysis_cache",
  "checkpoints",
  "exec_logs",
  "implement_experiments",
  "memory",
  "implement_attempts.json",
  "verify_report.json",
  "branch_search_result.json",
  "localization_search_result.json",
  "implement_task_spec.json",
  "long_term_memory_result.json"
]);
const execFile = promisify(execFileCallback);

type CandidateIsolationStrategy = "attempt_snapshot_restore" | "attempt_worktree";

type ImplementFailureType =
  | "implementation"
  | "localization"
  | "environment"
  | "policy"
  | "spec"
  | "missing_check";

interface ImplementTaskSpec {
  goal: string;
  acceptance_criteria: string[];
  non_goals: string[];
  constraints: string[];
  workspace: {
    root: string;
    run_dir: string;
    public_dir: string;
    metrics_path: string;
  };
  execution: {
    runner: AppConfig["experiments"]["runner"];
    timeout_sec: number;
  };
  context: {
    topic: string;
    objective_metric: string;
    plan_excerpt: string;
    hypotheses_excerpt: string;
    repo_listing: string;
    previous_summary?: string;
    previous_run_command?: string;
    previous_script?: string;
    stale_previous_implementation?: {
      previous_script?: string;
      previous_run_command?: string;
      reason: string;
    };
    environment_snapshot?: EnvironmentSnapshot;
    long_term_memory: LongTermMemorySnapshot;
    implementation_contract_feedback?: ImplementationContractFeedback;
    runner_feedback?: RunVerifierReport;
    prior_run_failure_constraints?: string[];
    paper_critique_feedback?: {
      overall_decision?: string;
      manuscript_type?: string;
      needs_additional_experiments?: boolean;
      blocking_issue_summaries: string[];
      recommended_fixes: string[];
      summary?: string;
    };
    resolved_constraint_profile?: CachedConstraintProfile["profile"];
    dependency_repair_context?: ImplementDependencyRepairContext;
    comparison_contract?: {
      plan_id: string;
      comparison_mode: "baseline_first_locked" | "objective_only";
      baseline_first_required: boolean;
      baseline_candidate_ids: string[];
      budget_profile: {
        mode: string;
        timeout_sec: number;
        total_trials?: number;
      };
      evaluator_contract_id: string;
    };
    estimator_feasibility?: ReturnType<
      typeof compactEstimatorFeasibilityForImplementation
    >;
    topic_probe_execution_authorization?: {
      status: TopicProbeExecutionAuthorizationGateArtifact["status"];
      effective_execution_authorized: boolean;
      content_sha256: string;
    };
    topic_probe_compute_contract?: ImplementTopicProbeComputeContract;
    planned_condition_contract?: PlannedConditionContract;
    plan_changed: boolean;
    plan_hash: string;
  };
}

interface PlannedConditionContract {
  required_condition_count?: number;
  required_run_count?: number;
  seed_schedule?: number[];
  minimum_seeds_per_condition?: number;
  baseline_condition_marker?: string;
  required_condition_markers: string[];
  primary_metric_key?: string;
  full_evaluation_required?: boolean;
  minimum_eval_examples_per_task?: Record<string, number>;
  notes: string[];
}

interface ImplementTopicProbeComputeContract {
  stage: TopicProbeComputeStage;
  active_contract_content_sha256: string;
  active_limit: TopicProbeComputeStageLimit;
  requested_gpu_count: {
    type: "integer";
    minimum: 0;
    maximum: number;
  };
  compute_usage_schema: {
    type: "object";
    additionalProperties: false;
    required: readonly string[];
    properties: Record<string, unknown>;
    oneOf: readonly unknown[];
  };
}

interface VerifyReport {
  status: "pass" | "fail" | "not_run";
  command?: string;
  cwd?: string;
  exit_code?: number;
  failure_type?: ImplementFailureType;
  policy_rule_id?: string;
  policy_reason?: string;
  next_action:
    | "accept"
    | "retry_patch"
    | "relocalize"
    | "handoff_to_run_experiments"
    | "stop_for_environment"
    | "stop_for_policy";
  stdout_excerpt?: string;
  stderr_excerpt?: string;
  summary: string;
}

interface ImplementationContractFeedback {
  source: "implement_experiments";
  status: "fail";
  stage: "design_implementation_validation" | "local_verification";
  summary: string;
  stderr_excerpt?: string;
  blocking_findings: Array<{
    code: string;
    message: string;
    evidence?: string;
  }>;
  suggested_next_action: string;
  recorded_at: string;
}

type ImplementProgressStage = "preflight" | "attempt" | "localize" | "codex" | "verify" | "publish" | "completed" | "failed";

interface ImplementProgressStatus {
  status: "running" | "completed" | "failed";
  stage: ImplementProgressStage;
  message: string;
  startedAt: string;
  updatedAt: string;
  progressCount: number;
  attempt?: number;
  maxAttempts: number;
  threadId?: string;
  publicDir?: string;
  scriptPath?: string;
  runCommand?: string;
  testCommand?: string;
  verificationCommand?: string;
  verifyStatus?: VerifyReport["status"];
}

interface AttemptRecord {
  attempt: number;
  summary: string;
  branch_plan: BranchPlan;
  localization: LocalizationResult;
  search_localization?: LocalizationResult;
  verify_report: VerifyReport;
  reflection?: EpisodeRecord;
  changed_files: string[];
  artifacts: string[];
  public_artifacts: string[];
  raw_response: string;
  restored_after_failure?: boolean;
  restored_paths?: string[];
}

interface PreparedImplementAttempt {
  threadId?: string;
  branchPlan: BranchPlan;
  comparisonContract?: ExperimentComparisonContract;
  workspaceRoot: string;
  rawResponse: string;
  summary: string;
  runCommand: string;
  testCommand?: string;
  originalScriptPath?: string;
  scriptPath?: string;
  metricsPath: string;
  workingDir: string;
  experimentMode: string;
  publicDir: string;
  changedFiles: string[];
  artifacts: string[];
  publicArtifacts: string[];
  localization: LocalizationResult;
  assumptions: string[];
  requestedGpuCount?: number;
  verifyReport: VerifyReport;
}

interface ImplementAttemptSnapshot {
  snapshotRoot: string;
  orphanedResiduePaths: string[];
  capturePaths(paths: Array<string | undefined>): Promise<void>;
  markCreatedPaths(paths: Array<string | undefined>): void;
  restore(): Promise<{ restoredPaths: string[] }>;
  cleanup(): Promise<void>;
}

interface AttemptIsolationContext {
  requestedStrategy: CandidateIsolationStrategy;
  effectiveStrategy: CandidateIsolationStrategy;
  fallbackFrom?: "attempt_worktree";
  fallbackReason?: string;
  controlWorkspaceRoot: string;
  workspaceRoot: string;
  runDir: string;
  publicDir: string;
  metricsPath: string;
  attemptSnapshot?: ImplementAttemptSnapshot;
  worktreePath?: string;
  orphanedResiduePaths: string[];
}

interface BranchPlan {
  branch_id: string;
  source: "search_primary" | "search_alternate" | "repair_retry";
  summary: string;
  rationale: string;
  focus_files: string[];
  candidate_pool: string[];
}

interface LongTermMemoryHint {
  id: string;
  category: string;
  text: string;
  tags: string[];
  created_at: string;
}

interface LongTermMemorySnapshot {
  search_queries: string[];
  retrieved: LongTermMemoryHint[];
  saved?: LongTermMemoryHint;
}

export class ImplementSessionManager {
  private readonly localizer: ImplementationLocalizer;

  constructor(private readonly deps: ImplementSessionDeps) {
    this.localizer = new ImplementationLocalizer(deps.aci);
  }

  async run(
    run: RunRecord,
    abortSignal?: AbortSignal,
    environmentSnapshot?: EnvironmentSnapshot
  ): Promise<ImplementSessionSummary> {
    const runContext = new RunContextMemory(
      resolveWorkspaceMemoryPath(this.deps.workspaceRoot, run.memoryRefs.runContextPath)
    );
    const memoryRawBrief = await runContext.get<string>("run_brief.raw");
    const snapshotBrief = await loadResearchBriefSnapshot(
      this.deps.workspaceRoot,
      run.id
    );
    const researchModeGuard = await resolveResearchRunModeGuard({
      workspaceRoot: this.deps.workspaceRoot,
      runId: run.id,
      rawBrief: memoryRawBrief || snapshotBrief,
      run,
      expectedResearchCycle: run.graph.researchCycle,
      requireActiveBoundedProbeLineage: true
    });
    if (!researchModeGuard.valid) {
      throw new ImplementSessionStopError(
        "implement_experiments_research_mode_preflight_blocked:"
          + researchModeGuard.reasons.join(","),
        "gate_blocked",
        0
      );
    }
    if (researchModeGuard.effectiveMode === "topic_discovery") {
      const executionAuthorizationGate = await loadTopicProbeExecutionAuthorizationGate({
        workspaceRoot: this.deps.workspaceRoot,
        runId: run.id,
        expectedResearchCycle: run.graph.researchCycle
      });
      await runContext.put(
        "research_governance.topic_probe_execution_authorization",
        executionAuthorizationGate
      );
      if (!executionAuthorizationGate.effective_execution_authorized) {
        throw new ImplementSessionStopError(
          "topic_probe_execution_preflight_blocked:"
            + executionAuthorizationGate.authorization.reason_codes.join(","),
          "gate_blocked",
          0
        );
      }
      const estimatorGate = await validatePersistedEstimatorFeasibilityGate({
        workspaceRoot: this.deps.workspaceRoot,
        runId: run.id,
        expectedResearchCycle: run.graph.researchCycle
      });
      await runContext.put(
        "research_governance.estimator_feasibility_gate",
        estimatorGate
      );
      if (!estimatorGate.valid) {
        throw new ImplementSessionStopError(
          "topic_probe_execution_preflight_projection_divergence:"
            + estimatorGate.reasons.join(","),
          "gate_blocked",
          0
        );
      }
    }
    const episodeMemory = new EpisodeMemory(
      resolveWorkspaceMemoryPath(this.deps.workspaceRoot, run.memoryRefs.episodePath)
    );
    const longTermStore = new LongTermStore(
      resolveWorkspaceMemoryPath(this.deps.workspaceRoot, run.memoryRefs.longTermPath)
    );
    const runDir = path.join(this.deps.workspaceRoot, ".autolabos", "runs", run.id);
    const metricsPath = path.join(runDir, "metrics.json");
    const defaultPublicDir = buildPublicExperimentDir(this.deps.workspaceRoot, run);
    const experimentLlmProfile = resolveExperimentLlmProfile(this.deps.config);
    const canUseCodexSession = !hasStructuredLlmClient(this.deps.llm);
    const currentThreadId =
      run.nodeThreads.implement_experiments ||
      (await runContext.get<string>("implement_experiments.thread_id"));

    const changedFiles = new Set<string>();
    const artifacts = new Set<string>();
    const publicArtifacts = new Set<string>();
    const historicalChangedFiles = new Set<string>();
    const rawEvents: CodexEvent[] = [];
    const startedAt = new Date().toISOString();
    let progressCount = 0;
    let progressQueue: Promise<void> = Promise.resolve();
    await ensureDir(defaultPublicDir);
    await ensureDir(path.join(runDir, "implement_experiments"));
    if (environmentSnapshot) {
      await writeJsonFile(path.join(runDir, "environment_snapshot.json"), environmentSnapshot);
      await runContext.put("implement_experiments.environment_snapshot", environmentSnapshot);
    }
    const longTermMemory = await loadImplementationLongTermMemory(longTermStore, run);
    const taskSpec = await this.buildTaskSpec(
      run,
      runDir,
      defaultPublicDir,
      metricsPath,
      runContext,
      longTermMemory,
      environmentSnapshot
    );
    const useCodexSession =
      canUseCodexSession && !shouldFallbackToStagedImplementLlm(taskSpec.context.previous_summary || "");
    await writeJsonFile(path.join(runDir, "implement_task_spec.json"), taskSpec);

    const queueProgressUpdate = (
      stage: ImplementProgressStage,
      message: string,
      extras: Partial<Omit<ImplementProgressStatus, "status" | "stage" | "message" | "startedAt" | "updatedAt" | "progressCount" | "maxAttempts">> = {}
    ) => {
      const updatedAt = new Date().toISOString();
      progressCount += 1;
      const nextStatus: ImplementProgressStatus = {
        status: "running",
        stage,
        message,
        startedAt,
        updatedAt,
        progressCount,
        maxAttempts: MAX_IMPLEMENT_ATTEMPTS,
        threadId: extras.threadId,
        attempt: extras.attempt,
        publicDir: extras.publicDir,
        scriptPath: extras.scriptPath,
        runCommand: extras.runCommand,
        testCommand: extras.testCommand,
        verificationCommand: extras.verificationCommand,
        verifyStatus: extras.verifyStatus
      };
      progressQueue = progressQueue.then(async () => {
        await appendImplementProgressItem(runDir, {
          index: nextStatus.progressCount,
          timestamp: updatedAt,
          stage,
          message,
          attempt: nextStatus.attempt,
          threadId: nextStatus.threadId,
          verifyStatus: nextStatus.verifyStatus
        });
        await writeImplementProgressStatus(runDir, nextStatus);
      });
    };
    const flushProgressUpdates = async () => {
      await progressQueue;
    };
    const emitImplementObservation = (
      stage: ImplementProgressStage,
      text: string,
      extras: Partial<Omit<ImplementProgressStatus, "status" | "stage" | "message" | "startedAt" | "updatedAt" | "progressCount" | "maxAttempts">> = {}
    ) => {
      this.deps.eventStream.emit({
        type: "OBS_RECEIVED",
        runId: run.id,
        node: "implement_experiments",
        agentRole: "implementer",
        payload: {
          text
        }
      });
      queueProgressUpdate(stage, text, extras);
    };

    await writeImplementProgressStatus(runDir, {
      status: "running",
      stage: "preflight",
      message: "Implementation task spec prepared.",
      startedAt,
      updatedAt: startedAt,
      progressCount,
      maxAttempts: MAX_IMPLEMENT_ATTEMPTS,
      publicDir: defaultPublicDir
    });
    emitImplementObservation(
      "preflight",
      `Implementation session starting in ${useCodexSession ? "codex_native" : "staged_llm"} mode.`,
      { publicDir: defaultPublicDir }
    );

    this.deps.eventStream.emit({
      type: "PLAN_CREATED",
      runId: run.id,
      node: "implement_experiments",
      agentRole: "implementer",
      payload: {
        text: "Implementation task spec prepared.",
        task_spec: taskSpec
      }
    });
    if (longTermMemory.retrieved.length > 0) {
      emitImplementObservation(
        "preflight",
        `Loaded ${longTermMemory.retrieved.length} long-term implementation hint(s).`,
        { publicDir: defaultPublicDir }
      );
    }
    if (taskSpec.context.runner_feedback) {
      emitImplementObservation(
        "preflight",
        `Loaded runner feedback from run_experiments: ${taskSpec.context.runner_feedback.summary}`,
        { publicDir: defaultPublicDir }
      );
    }
    if (taskSpec.context.implementation_contract_feedback) {
      emitImplementObservation(
        "preflight",
        `Loaded implementation contract feedback: ${taskSpec.context.implementation_contract_feedback.summary}`,
        { publicDir: defaultPublicDir }
      );
    }
    if (taskSpec.context.paper_critique_feedback) {
      emitImplementObservation(
        "preflight",
        `Loaded paper critique feedback from write_paper: ${taskSpec.context.paper_critique_feedback.summary || "additional experimental evidence is required"}`,
        { publicDir: defaultPublicDir }
      );
    }
    let activeThreadId = currentThreadId;
    if (
      activeThreadId &&
      (
        taskSpec.context.plan_changed ||
        taskSpec.context.implementation_contract_feedback ||
        taskSpec.context.runner_feedback ||
        taskSpec.context.paper_critique_feedback
      )
    ) {
      activeThreadId = undefined;
      await runContext.put("implement_experiments.thread_id", null);
      const latestRun = (await this.deps.runStore.getRun(run.id)) || run;
      if (latestRun.nodeThreads.implement_experiments) {
        delete latestRun.nodeThreads.implement_experiments;
        await this.deps.runStore.updateRun(latestRun);
      }
      emitImplementObservation(
        "preflight",
        taskSpec.context.plan_changed
          ? "Experiment plan changed since the last implement cycle; starting a fresh implementation thread."
          : taskSpec.context.implementation_contract_feedback
            ? "Implementation contract feedback changed the repair target; starting a fresh implementation thread."
            : taskSpec.context.runner_feedback
              ? "Runner feedback changed the repair target; starting a fresh implementation thread."
              : "Paper critique requested additional implementation evidence; starting a fresh implementation thread.",
        { publicDir: defaultPublicDir }
      );
    }
    let finalAttempt: PreparedImplementAttempt | undefined;
    let finalIsolation: AttemptIsolationContext | undefined;
    let finalDesignImplementationValidation: ExperimentDesignImplementationValidationReport | undefined;
    const attemptRecords: AttemptRecord[] = [];
    let latestSearchLocalization: LocalizationResult | undefined;
    let recentReflections = await episodeMemory.recent(run.id, "implement_experiments", 3);
    let restoredAttemptCount = 0;
    const requestedIsolationStrategy = resolveConfiguredCandidateIsolationStrategy(this.deps.config);
    const candidateIsolationAttempts: CandidateIsolationAttemptReport[] = [];

    for (let attempt = 1; attempt <= MAX_IMPLEMENT_ATTEMPTS; attempt += 1) {
      emitImplementObservation("attempt", `Implementation attempt ${attempt}/${MAX_IMPLEMENT_ATTEMPTS} started.`, {
        attempt,
        threadId: activeThreadId,
        publicDir: defaultPublicDir
      });

      const attemptStartedAt = new Date().toISOString();
      const branchContextFiles = dedupeStrings([...changedFiles, ...historicalChangedFiles]);
      const rawSearchLocalization = await this.localizer.localize(
        this.buildLocalizerInput(taskSpec, attemptRecords.at(-1), branchContextFiles)
      );
      const defaultFocusFiles = await buildDefaultImplementFocusFiles(taskSpec);
      const runnerGuardedLocalization = applyRunnerFeedbackLocalizationGuard(
        taskSpec,
        rawSearchLocalization,
        defaultFocusFiles
      );
      const searchLocalization = applyImplementationContractLocalizationGuard(
        taskSpec,
        runnerGuardedLocalization,
        defaultFocusFiles
      );
      latestSearchLocalization = searchLocalization;
      await writeJsonFile(path.join(runDir, "localization_search_result.json"), latestSearchLocalization || {});
      const branchLockOptions = isImplementationScheduleContractRepair(taskSpec)
        ? {
            lockFocusToLocalization: true,
            lockReason:
              "Design-to-implementation schedule feedback must repair the canonical runnable contract before exploring alternate files."
          }
        : hasConcretePlannedConditionContract(taskSpec)
          ? {
              lockFocusToLocalization: true,
              lockReason:
                "Concrete planned condition contracts must stay pinned to the canonical runnable implementation until the contract is satisfied."
            }
          : undefined;
      const branchPlan = chooseBranchPlan(
        searchLocalization,
        attemptRecords,
        branchContextFiles,
        defaultFocusFiles,
        branchLockOptions
      );
      const isolation = await createAttemptIsolationContext({
        config: this.deps.config,
        workspaceRoot: this.deps.workspaceRoot,
        run,
        runDir,
        defaultPublicDir,
        metricsPath,
        attempt,
        requestedStrategy: requestedIsolationStrategy
      });
      await isolation.attemptSnapshot?.capturePaths([
        defaultPublicDir,
        metricsPath,
        ...(await listRestorableRunDirEntries(runDir)),
        ...branchContextFiles,
        ...branchPlan.focus_files,
        ...branchPlan.candidate_pool,
        ...searchLocalization.selected_files,
        ...searchLocalization.candidates.map((candidate) => candidate.path)
      ]);
      const attemptChangedFiles = new Set<string>(changedFiles);
      const attemptArtifacts = new Set<string>(artifacts);
      const attemptPublicArtifacts = new Set<string>(publicArtifacts);
      const promptTaskSpec = translateTaskSpecToWorkspace(taskSpec, {
        fromWorkspaceRoot: this.deps.workspaceRoot,
        toWorkspaceRoot: isolation.workspaceRoot,
        runDir: isolation.runDir,
        publicDir: isolation.publicDir,
        metricsPath: isolation.metricsPath
      });
      const promptSearchLocalization = translateLocalizationResultWorkspace(searchLocalization, {
        fromWorkspaceRoot: this.deps.workspaceRoot,
        toWorkspaceRoot: isolation.workspaceRoot
      });
      const actualSearchLocalization = promptSearchLocalization;
      const promptBranchPlan = translateBranchPlanWorkspace(branchPlan, {
        fromWorkspaceRoot: this.deps.workspaceRoot,
        toWorkspaceRoot: isolation.workspaceRoot
      });
      const promptPreviousAttempt = translateAttemptRecordWorkspace(attemptRecords.at(-1), {
        fromWorkspaceRoot: this.deps.workspaceRoot,
        toWorkspaceRoot: isolation.workspaceRoot
      });

      emitImplementObservation("localize", `Search-backed localization: ${formatLocalizationSummary(searchLocalization)}`, {
        attempt,
        threadId: activeThreadId,
        publicDir: defaultPublicDir
      });
      emitImplementObservation(
        "localize",
        `Branch focus ${branchPlan.branch_id}: ${branchPlan.focus_files.join(", ") || "(no explicit file focus)"}`,
        {
          attempt,
          threadId: activeThreadId,
          publicDir: defaultPublicDir
        }
      );

      const streamProgress = createCodexProgressEmitter((text) => {
        emitImplementObservation("codex", text, {
          attempt,
          threadId: activeThreadId,
          publicDir: defaultPublicDir
        });
      });
      const attemptPrompt = this.buildAttemptPrompt({
        taskSpec: promptTaskSpec,
        searchLocalization: promptSearchLocalization,
        branchPlan: promptBranchPlan,
        recentReflections,
        attempt,
        previousAttempt: promptPreviousAttempt,
        existingChangedFiles: translatePathsBetweenWorkspaces([...changedFiles], {
          fromWorkspaceRoot: this.deps.workspaceRoot,
          toWorkspaceRoot: isolation.workspaceRoot
        }),
        historicalChangedFiles: translatePathsBetweenWorkspaces([...historicalChangedFiles], {
          fromWorkspaceRoot: this.deps.workspaceRoot,
          toWorkspaceRoot: isolation.workspaceRoot
        }),
        sessionMode: useCodexSession ? "codex_native" : "staged_llm"
      });
      const attemptSystemPrompt = this.buildSystemPrompt(
        isolation.runDir,
        isolation.publicDir,
        isolation.metricsPath,
        experimentLlmProfile,
        useCodexSession ? "codex_native" : "staged_llm",
        taskSpec.context.environment_snapshot,
        taskSpec.context.topic_probe_compute_contract
      );

      let result: RunTurnResult;
      const recoveredBeforeTurn = await recoverStructuredResultFromPublicBundle({
        publicDir: isolation.publicDir,
        runDir: isolation.runDir,
        metricsPath: isolation.metricsPath,
        workspaceRoot: isolation.workspaceRoot,
        errorMessage: "Recovered an already materialized governed experiment bundle before re-entering Codex.",
        requireFreshPlanAlignment: Boolean(
          promptTaskSpec.context.plan_changed ||
          promptTaskSpec.context.implementation_contract_feedback ||
          promptTaskSpec.context.runner_feedback ||
          promptTaskSpec.context.paper_critique_feedback
        ),
        runnerFeedback: promptTaskSpec.context.runner_feedback,
        plannedConditionContract: promptTaskSpec.context.planned_condition_contract
      });
      if (
        recoveredBeforeTurn &&
        (await hasRecoverableExecutionEvidence(isolation.publicDir, isolation.metricsPath))
      ) {
        emitImplementObservation(
          "codex",
          "Reused an unchanged governed experiment bundle with existing execution evidence instead of re-entering Codex.",
          {
            attempt,
            threadId: activeThreadId,
            publicDir: isolation.publicDir
          }
        );
        result = recoveredBeforeTurn;
      } else {
        try {
          if (useCodexSession) {
            const codexTimeoutMs = getImplementLlmTimeoutMs(this.deps.config);
            const codexTimeoutController = codexTimeoutMs > 0 ? new AbortController() : undefined;
            const codexTimeoutId = codexTimeoutController
              ? setTimeout(() => codexTimeoutController.abort(), codexTimeoutMs)
              : undefined;
            const codexAbortSignal = codexTimeoutController
              ? abortSignal
                ? AbortSignal.any([abortSignal, codexTimeoutController.signal])
                : codexTimeoutController.signal
              : abortSignal;
            try {
              const codexRun = this.deps.codex.runTurnStream({
                  prompt: attemptPrompt,
                  threadId: activeThreadId,
                  agentId: `implementer:${run.id}`,
                  systemPrompt: attemptSystemPrompt,
                  sandboxMode: "workspace-write",
                  approvalPolicy: "never",
                  workingDirectory: toSandboxFriendlyWorkspaceRoot(isolation.workspaceRoot),
                  abortSignal: codexAbortSignal,
                  onEvent: (event) => {
                    rawEvents.push(event);
                    streamProgress.onEvent(event);
                    const mapped = mapCodexEventToAutoLabOSEvents({
                      event,
                      runId: run.id,
                      node: "implement_experiments",
                      agentRole: "implementer",
                      workspaceRoot: isolation.workspaceRoot
                    });
                    for (const item of mapped) {
                      const nextItem = translateMappedCodexEventToPrimaryWorkspace(item, {
                        fromWorkspaceRoot: isolation.workspaceRoot,
                        toWorkspaceRoot: this.deps.workspaceRoot
                      });
                      if (item.type === "PATCH_APPLIED" && !shouldTrackPatchEvent(item.payload)) {
                        continue;
                      }
                      this.deps.eventStream.emit(nextItem);
                      const fileValue = typeof item.payload.file === "string" ? item.payload.file : undefined;
                      if (fileValue && item.type === "PATCH_APPLIED") {
                        attemptChangedFiles.add(fileValue);
                        attemptArtifacts.add(fileValue);
                      }
                    }
                  }
                });
              const timeoutRun = codexTimeoutController
                ? new Promise<never>((_, reject) => {
                    codexTimeoutController.signal.addEventListener(
                      "abort",
                      () => reject(new Error(`implement_experiments codex request timed out after ${codexTimeoutMs}ms`)),
                      { once: true }
                    );
                  })
                : undefined;
              result = timeoutRun ? await Promise.race([codexRun, timeoutRun]) : await codexRun;
            } catch (error) {
              if (codexTimeoutController?.signal.aborted && !abortSignal?.aborted) {
                emitImplementObservation("codex", `Codex implement turn timed out after ${codexTimeoutMs}ms.`, {
                  attempt,
                  threadId: activeThreadId,
                  publicDir: defaultPublicDir
                });
                throw new Error(`implement_experiments codex request timed out after ${codexTimeoutMs}ms`);
              }
              throw error;
            } finally {
              if (codexTimeoutId) {
                clearTimeout(codexTimeoutId);
              }
            }
            if (this.deps.llm && shouldFallbackToStagedImplementLlm(result.finalText)) {
              emitImplementObservation(
                "codex",
                "Codex implement turn reported a filesystem tooling blocker; retrying this attempt in staged_llm mode.",
                {
                  attempt,
                  threadId: activeThreadId,
                  publicDir: defaultPublicDir
                }
              );
              const llmTimeoutMs = getImplementLlmTimeoutMs(this.deps.config);
              const filesystemFallbackPrompt = this.buildFilesystemFallbackRecoveryPrompt({
                taskSpec,
                searchLocalization,
                branchPlan,
                attempt
              });
              const filesystemFallbackSystemPrompt = appendFilesystemFallbackOverrideToPrompt(attemptSystemPrompt);
              const completion = await this.completeStagedLlmImplementationBundle({
                runDir,
                workspaceRoot: isolation.workspaceRoot,
                taskSpec: promptTaskSpec,
                searchLocalization: promptSearchLocalization,
                branchPlan: promptBranchPlan,
                scaffoldPrompt: filesystemFallbackPrompt,
                systemPrompt: filesystemFallbackSystemPrompt,
                timeoutMs: llmTimeoutMs,
                abortSignal,
                attempt,
                threadId: activeThreadId,
                publicDir: defaultPublicDir,
                emitImplementObservation,
                reasoningEffort: experimentLlmProfile.reasoningEffort
              });
              result = {
                threadId: completion.threadId || activeThreadId,
                finalText: completion.text,
                events: []
              };
            }
          } else {
            if (!this.deps.llm) {
              throw new Error("implement_experiments is configured for staged_llm mode, but no LLM client is available.");
            }
            const llmTimeoutMs = getImplementLlmTimeoutMs(this.deps.config);
            const completion = await this.completeStagedLlmImplementationBundle({
              runDir,
              workspaceRoot: isolation.workspaceRoot,
              taskSpec: promptTaskSpec,
              searchLocalization: promptSearchLocalization,
              branchPlan: promptBranchPlan,
              scaffoldPrompt: attemptPrompt,
              systemPrompt: attemptSystemPrompt,
              timeoutMs: llmTimeoutMs,
              abortSignal,
              attempt,
              threadId: activeThreadId,
              publicDir: defaultPublicDir,
              emitImplementObservation
            });
            result = {
              threadId: completion.threadId || activeThreadId,
              finalText: completion.text,
              events: []
            };
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          const allowCurrentAttemptBundleRecovery =
            isRetryableImplementStagedLlmMaterializationError(error) &&
            isProviderTerminatedStagedLlmError(error);
          const recovered = await recoverStructuredResultFromPublicBundle({
            publicDir: isolation.publicDir,
            runDir: isolation.runDir,
            metricsPath: isolation.metricsPath,
            workspaceRoot: isolation.workspaceRoot,
            errorMessage,
            materializedAfterMs: allowCurrentAttemptBundleRecovery
              ? Date.parse(attemptStartedAt)
              : undefined,
            requireFreshPlanAlignment:
              !allowCurrentAttemptBundleRecovery &&
              Boolean(
                promptTaskSpec.context.plan_changed ||
                promptTaskSpec.context.implementation_contract_feedback ||
                promptTaskSpec.context.runner_feedback ||
                promptTaskSpec.context.paper_critique_feedback
              ),
            runnerFeedback: promptTaskSpec.context.runner_feedback,
            plannedConditionContract: promptTaskSpec.context.planned_condition_contract
          });
          if (!recovered) {
            if (isRetryableImplementStagedLlmMaterializationError(error) && attempt < MAX_IMPLEMENT_ATTEMPTS) {
              const verifyReport: VerifyReport = {
                status: "fail",
                failure_type: "implementation",
                next_action: "retry_patch",
                stderr_excerpt: trimBlock(errorMessage, 1200) || errorMessage,
                summary: `Implementation materialization failed before a runnable bundle was produced; retrying with a fresh attempt: ${errorMessage}`
              };
              attemptRecords.push({
                attempt,
                summary: verifyReport.summary,
                branch_plan: branchPlan,
                localization: actualSearchLocalization,
                search_localization: searchLocalization,
                verify_report: verifyReport,
                changed_files: [],
                artifacts: [],
                public_artifacts: [],
                raw_response: "",
                restored_after_failure: false,
                restored_paths: []
              });
              await writeJsonFile(path.join(runDir, "verify_report.json"), verifyReport);
              await writeJsonFile(path.join(runDir, "implement_attempts.json"), {
                attempts: attemptRecords
              });
              emitImplementObservation("attempt", verifyReport.summary, {
                attempt,
                threadId: activeThreadId,
                publicDir: isolation.publicDir
              });

              const restoreResult = await restoreIsolationContextForRetry(isolation);
              if (restoreResult.restoredPaths.length > 0 || isolation.effectiveStrategy === "attempt_snapshot_restore") {
                restoredAttemptCount += 1;
              }
              const lastAttempt = attemptRecords.at(-1);
              if (lastAttempt) {
                lastAttempt.restored_after_failure = true;
                lastAttempt.restored_paths = restoreResult.restoredPaths;
              }
              await writeJsonFile(path.join(runDir, "implement_attempts.json"), {
                attempts: attemptRecords
              });
              replaceSetContents(changedFiles, []);
              replaceSetContents(artifacts, []);
              replaceSetContents(publicArtifacts, []);
              emitImplementObservation(
                "attempt",
                `Restored ${restoreResult.restoredPaths.length} path(s) before retrying after staged materialization failure.`,
                {
                  attempt,
                  threadId: activeThreadId,
                  publicDir: defaultPublicDir
                }
              );
              const retryIsolationAttempt: CandidateIsolationAttemptReport = {
                attempt,
                requested_strategy: requestedIsolationStrategy,
                effective_strategy: isolation.effectiveStrategy,
                fallback_from: isolation.fallbackFrom,
                fallback_reason: isolation.fallbackReason,
                workspace_root: this.deps.workspaceRoot,
                isolated_workspace_root:
                  isolation.effectiveStrategy === "attempt_worktree" ? isolation.workspaceRoot : undefined,
                snapshot_root: isolation.attemptSnapshot?.snapshotRoot,
                worktree_path: isolation.worktreePath,
                restored_paths: restoreResult.restoredPaths,
                restored_after_failure: true,
                cleanup_status: "completed",
                cleanup_notes: [],
                orphaned_residue_paths: isolation.orphanedResiduePaths,
                started_at: attemptStartedAt,
                finished_at: new Date().toISOString()
              };
              candidateIsolationAttempts.push(retryIsolationAttempt);
              const retryCleanup = await cleanupIsolationContext(isolation);
              retryIsolationAttempt.cleanup_status = retryCleanup.status;
              retryIsolationAttempt.cleanup_notes = retryCleanup.notes;
              continue;
            }
            const verifyReport = buildImplementationTurnFailureReport(errorMessage);
            attemptRecords.push({
              attempt,
              summary: verifyReport.summary,
              branch_plan: branchPlan,
              localization: actualSearchLocalization,
              search_localization: searchLocalization,
              verify_report: verifyReport,
              changed_files: [],
              artifacts: [],
              public_artifacts: [],
              raw_response: ""
            });
            await writeJsonFile(path.join(runDir, "verify_report.json"), verifyReport);
            await writeJsonFile(path.join(runDir, "implement_attempts.json"), {
              attempts: attemptRecords
            });
            emitImplementObservation("failed", verifyReport.summary, {
              attempt,
              threadId: activeThreadId,
              publicDir: isolation.publicDir
            });
            await flushProgressUpdates();
            await writeImplementProgressStatus(runDir, {
              status: "failed",
              stage: "failed",
              message: verifyReport.summary,
              startedAt,
              updatedAt: new Date().toISOString(),
              progressCount,
              maxAttempts: MAX_IMPLEMENT_ATTEMPTS,
              threadId: activeThreadId,
              attempt,
              publicDir: isolation.publicDir
            });
            throw new ImplementSessionStopError(verifyReport.summary);
          }
          emitImplementObservation(
            "codex",
            "Recovered implement result from a materialized public bundle after Codex stream failure.",
            {
              attempt,
              threadId: activeThreadId,
              publicDir: isolation.publicDir
            }
          );
          result = recovered;
        }
      }
      streamProgress.flush();

      activeThreadId = result.threadId || activeThreadId;
      queueProgressUpdate("codex", "Implementation turn completed.", {
        attempt,
        threadId: activeThreadId,
        publicDir: defaultPublicDir
      });
      const prepared = await this.prepareAttemptResult({
        run,
        workspaceRoot: isolation.workspaceRoot,
        runDir: isolation.runDir,
        defaultPublicDir: isolation.publicDir,
        metricsPath: isolation.metricsPath,
        branchPlan,
        result,
        changedFiles: attemptChangedFiles,
        artifacts: attemptArtifacts,
        publicArtifacts: attemptPublicArtifacts,
        attemptSnapshot: isolation.attemptSnapshot,
        experimentLlmProfile
      });
      const preparedDisplay = translatePreparedAttemptToWorkspace(prepared, {
        fromWorkspaceRoot: isolation.workspaceRoot,
        toWorkspaceRoot: this.deps.workspaceRoot
      });
      prepared.localization = mergeLocalizationResults(
        actualSearchLocalization,
        prepared.localization,
        inferLocalizationFromArtifacts({
          changedFiles: prepared.changedFiles,
          scriptPath: prepared.scriptPath,
          publicDir: prepared.publicDir
        })
      );

      emitImplementObservation("localize", formatLocalizationSummary(prepared.localization), {
        attempt,
        threadId: activeThreadId,
        publicDir: prepared.publicDir,
        scriptPath: prepared.scriptPath,
        runCommand: prepared.runCommand,
        testCommand: prepared.testCommand
      });

      const wrapperTargetScriptPath = await resolvePythonVerificationScriptPath(prepared.scriptPath);
      if (wrapperTargetScriptPath && path.normalize(wrapperTargetScriptPath) !== path.normalize(prepared.scriptPath || "")) {
        const originalScriptPath = prepared.scriptPath;
        prepared.originalScriptPath = prepared.originalScriptPath || originalScriptPath;
        prepared.scriptPath = wrapperTargetScriptPath;
        prepared.changedFiles = dedupeStrings([...prepared.changedFiles, wrapperTargetScriptPath]);
        prepared.artifacts = dedupeStrings([...prepared.artifacts, wrapperTargetScriptPath]);
        if (isSubpath(wrapperTargetScriptPath, prepared.publicDir)) {
          prepared.publicArtifacts = dedupeStrings([...prepared.publicArtifacts, wrapperTargetScriptPath]);
        }
        emitImplementObservation(
          "verify",
          `Resolved public wrapper script_path to ${path.basename(wrapperTargetScriptPath)} before semantic design validation.`,
          {
            attempt,
            threadId: activeThreadId,
            publicDir: prepared.publicDir,
            scriptPath: prepared.scriptPath,
            runCommand: prepared.runCommand
          }
        );
      }

      const comparisonContract = await loadExperimentComparisonContract(run, runContext);
      const publicPlannedContractArtifactRepair = await materializePublicPlannedConditionContractArtifact({
        publicDir: prepared.publicDir,
        contract: promptTaskSpec.context.planned_condition_contract
      });
      if (publicPlannedContractArtifactRepair.artifactPath) {
        prepared.publicArtifacts = dedupeStrings([
          ...prepared.publicArtifacts,
          publicPlannedContractArtifactRepair.artifactPath
        ]);
      }
      if (publicPlannedContractArtifactRepair.repaired && publicPlannedContractArtifactRepair.artifactPath) {
        prepared.changedFiles = dedupeStrings([
          ...prepared.changedFiles,
          publicPlannedContractArtifactRepair.artifactPath
        ]);
        emitImplementObservation(
          "verify",
          publicPlannedContractArtifactRepair.message ||
            "Materialized public planned condition contract artifact before design validation.",
          {
            attempt,
            threadId: activeThreadId,
            publicDir: prepared.publicDir,
            scriptPath: prepared.scriptPath,
            runCommand: prepared.runCommand
          }
        );
      }
      const publicPlannedContractDocsRepair = await repairPublicPlannedConditionContractDocsSurface({
        publicDir: prepared.publicDir,
        contract: promptTaskSpec.context.planned_condition_contract
      });
      if (publicPlannedContractDocsRepair.artifactPaths.length > 0) {
        prepared.publicArtifacts = dedupeStrings([
          ...prepared.publicArtifacts,
          ...publicPlannedContractDocsRepair.artifactPaths
        ]);
      }
      if (publicPlannedContractDocsRepair.repaired) {
        prepared.changedFiles = dedupeStrings([
          ...prepared.changedFiles,
          ...publicPlannedContractDocsRepair.artifactPaths
        ]);
        emitImplementObservation(
          "verify",
          publicPlannedContractDocsRepair.message ||
            "Aligned public planned condition contract docs before design validation.",
          {
            attempt,
            threadId: activeThreadId,
            publicDir: prepared.publicDir,
            scriptPath: prepared.scriptPath,
            runCommand: prepared.runCommand
          }
        );
      }
      const designImplementationValidation = enforceUnresolvedImplementationContractFeedback(
        await validateDesignImplementationAlignment({
        comparisonContract,
        plannedConditionContract: promptTaskSpec.context.planned_condition_contract,
        attempt: {
          runCommand: prepared.runCommand,
          testCommand: prepared.testCommand,
          scriptPath: prepared.scriptPath,
          metricsPath: prepared.metricsPath,
          workingDir: prepared.workingDir,
          publicDir: prepared.publicDir,
          changedFiles: prepared.changedFiles,
          publicArtifacts: prepared.publicArtifacts
        }
        }),
        taskSpec
      );
      prepared.comparisonContract = comparisonContract;
      finalDesignImplementationValidation = designImplementationValidation;
      if (designImplementationValidation.verdict === "block") {
        prepared.verifyReport = buildDesignImplementationValidationVerifyReport(
          designImplementationValidation
        );
      }

      const verifyReport = await this.verifyAttempt(prepared, abortSignal, run.id, attempt, (text, extras) => {
        queueProgressUpdate("verify", text, {
          attempt,
          threadId: activeThreadId,
          publicDir: prepared.publicDir,
          scriptPath: prepared.scriptPath,
          runCommand: prepared.runCommand,
          testCommand: prepared.testCommand,
          ...extras
        });
      });
      prepared.verifyReport = verifyReport;
      finalAttempt = prepared;
      attemptRecords.push({
        attempt,
        summary: preparedDisplay.summary,
        branch_plan: branchPlan,
        localization: preparedDisplay.localization,
        search_localization: searchLocalization,
        verify_report: verifyReport,
        reflection:
          verifyReport.status === "fail"
            ? await this.saveFailureReflection({
                episodeMemory,
                run,
                taskSpec,
                branchPlan,
                attempt,
                verifyReport,
                prepared: preparedDisplay,
                searchLocalization
              })
            : undefined,
        changed_files: preparedDisplay.changedFiles,
        artifacts: preparedDisplay.artifacts,
        public_artifacts: preparedDisplay.publicArtifacts,
        raw_response: prepared.rawResponse,
        restored_after_failure: false,
        restored_paths: []
      });
      await writeJsonFile(path.join(runDir, "verify_report.json"), verifyReport);
      await writeJsonFile(path.join(runDir, "implement_attempts.json"), {
        attempts: attemptRecords
      });
      recentReflections = await episodeMemory.recent(run.id, "implement_experiments", 3);
      isolation.attemptSnapshot?.markCreatedPaths([
        prepared.scriptPath,
        prepared.metricsPath,
        prepared.publicDir,
        ...prepared.changedFiles,
        ...prepared.artifacts,
        ...prepared.publicArtifacts
      ]);

      if (verifyReport.status !== "fail") {
        finalIsolation = isolation;
        replaceSetContents(changedFiles, preparedDisplay.changedFiles);
        replaceSetContents(artifacts, preparedDisplay.artifacts);
        replaceSetContents(publicArtifacts, preparedDisplay.publicArtifacts);
        candidateIsolationAttempts.push({
          attempt,
          requested_strategy: requestedIsolationStrategy,
          effective_strategy: isolation.effectiveStrategy,
          fallback_from: isolation.fallbackFrom,
          fallback_reason: isolation.fallbackReason,
          workspace_root: this.deps.workspaceRoot,
          isolated_workspace_root:
            isolation.effectiveStrategy === "attempt_worktree" ? isolation.workspaceRoot : undefined,
          snapshot_root: isolation.attemptSnapshot?.snapshotRoot,
          worktree_path: isolation.worktreePath,
          restored_paths: [],
          restored_after_failure: false,
          cleanup_status: "skipped",
          cleanup_notes: [],
          orphaned_residue_paths: isolation.orphanedResiduePaths,
          started_at: attemptStartedAt,
          finished_at: new Date().toISOString()
        });
        break;
      }

      if (verifyReport.next_action === "stop_for_environment" || verifyReport.next_action === "stop_for_policy") {
        finalIsolation = isolation;
        replaceSetContents(changedFiles, preparedDisplay.changedFiles);
        replaceSetContents(artifacts, preparedDisplay.artifacts);
        replaceSetContents(publicArtifacts, preparedDisplay.publicArtifacts);
        candidateIsolationAttempts.push({
          attempt,
          requested_strategy: requestedIsolationStrategy,
          effective_strategy: isolation.effectiveStrategy,
          fallback_from: isolation.fallbackFrom,
          fallback_reason: isolation.fallbackReason,
          workspace_root: this.deps.workspaceRoot,
          isolated_workspace_root:
            isolation.effectiveStrategy === "attempt_worktree" ? isolation.workspaceRoot : undefined,
          snapshot_root: isolation.attemptSnapshot?.snapshotRoot,
          worktree_path: isolation.worktreePath,
          restored_paths: [],
          restored_after_failure: false,
          cleanup_status: "skipped",
          cleanup_notes: [],
          orphaned_residue_paths: isolation.orphanedResiduePaths,
          started_at: attemptStartedAt,
          finished_at: new Date().toISOString()
        });
        break;
      }
      if (attempt >= MAX_IMPLEMENT_ATTEMPTS) {
        finalIsolation = isolation;
        replaceSetContents(changedFiles, preparedDisplay.changedFiles);
        replaceSetContents(artifacts, preparedDisplay.artifacts);
        replaceSetContents(publicArtifacts, preparedDisplay.publicArtifacts);
        candidateIsolationAttempts.push({
          attempt,
          requested_strategy: requestedIsolationStrategy,
          effective_strategy: isolation.effectiveStrategy,
          fallback_from: isolation.fallbackFrom,
          fallback_reason: isolation.fallbackReason,
          workspace_root: this.deps.workspaceRoot,
          isolated_workspace_root:
            isolation.effectiveStrategy === "attempt_worktree" ? isolation.workspaceRoot : undefined,
          snapshot_root: isolation.attemptSnapshot?.snapshotRoot,
          worktree_path: isolation.worktreePath,
          restored_paths: [],
          restored_after_failure: false,
          cleanup_status: "skipped",
          cleanup_notes: [],
          orphaned_residue_paths: isolation.orphanedResiduePaths,
          started_at: attemptStartedAt,
          finished_at: new Date().toISOString()
        });
        break;
      }

      for (const filePath of preparedDisplay.changedFiles) {
        historicalChangedFiles.add(filePath);
      }
      const restoreResult = await restoreIsolationContextForRetry(isolation);
      if (restoreResult.restoredPaths.length > 0 || isolation.effectiveStrategy === "attempt_snapshot_restore") {
        restoredAttemptCount += 1;
      }
      const lastAttempt = attemptRecords.at(-1);
      if (lastAttempt) {
        lastAttempt.restored_after_failure = true;
        lastAttempt.restored_paths = restoreResult.restoredPaths;
      }
      await writeJsonFile(path.join(runDir, "implement_attempts.json"), {
        attempts: attemptRecords
      });
      replaceSetContents(changedFiles, []);
      replaceSetContents(artifacts, []);
      replaceSetContents(publicArtifacts, []);
      emitImplementObservation(
        "attempt",
        `Restored ${restoreResult.restoredPaths.length} path(s) before retrying the next candidate branch.`,
        {
          attempt,
          threadId: activeThreadId,
          publicDir: defaultPublicDir
        }
      );
      if (taskSpec.context.implementation_contract_feedback) {
        emitImplementObservation(
          "preflight",
          `Loaded implementation contract feedback: ${taskSpec.context.implementation_contract_feedback.summary}`,
          { publicDir: defaultPublicDir }
        );
        emitImplementObservation(
          "preflight",
          "Implementation contract feedback changed the repair target; starting a fresh implementation thread.",
          { publicDir: defaultPublicDir }
        );
      }
      const retryIsolationAttempt: CandidateIsolationAttemptReport = {
        attempt,
        requested_strategy: requestedIsolationStrategy,
        effective_strategy: isolation.effectiveStrategy,
        fallback_from: isolation.fallbackFrom,
        fallback_reason: isolation.fallbackReason,
        workspace_root: this.deps.workspaceRoot,
        isolated_workspace_root:
          isolation.effectiveStrategy === "attempt_worktree" ? isolation.workspaceRoot : undefined,
        snapshot_root: isolation.attemptSnapshot?.snapshotRoot,
        worktree_path: isolation.worktreePath,
        restored_paths: restoreResult.restoredPaths,
        restored_after_failure: true,
        cleanup_status: "completed",
        cleanup_notes: [],
        orphaned_residue_paths: isolation.orphanedResiduePaths,
        started_at: attemptStartedAt,
        finished_at: new Date().toISOString()
      };
      candidateIsolationAttempts.push(retryIsolationAttempt);
      const retryCleanup = await cleanupIsolationContext(isolation);
      retryIsolationAttempt.cleanup_status = retryCleanup.status;
      retryIsolationAttempt.cleanup_notes = retryCleanup.notes;
    }

    if (!finalAttempt) {
      throw new Error("Implementation session did not return an implementation attempt.");
    }
    if (finalIsolation?.effectiveStrategy === "attempt_worktree") {
      finalAttempt = await materializeWorktreeAttemptToPrimaryWorkspace(finalAttempt, {
        fromWorkspaceRoot: finalIsolation.workspaceRoot,
        toWorkspaceRoot: this.deps.workspaceRoot
      });
    }
    if (finalIsolation) {
      const cleanup = await cleanupIsolationContext(finalIsolation);
      const lastIsolationAttempt = candidateIsolationAttempts.at(-1);
      if (lastIsolationAttempt) {
        lastIsolationAttempt.cleanup_status = cleanup.status;
        lastIsolationAttempt.cleanup_notes = cleanup.notes;
      }
    }

    const publishedArtifacts = await publishReusableArtifacts({
      changedFiles: [...changedFiles],
      artifacts: [...artifacts],
      explicitPublicArtifacts: [...publicArtifacts],
      runDir,
      publicDir: finalAttempt.publicDir
    });
    for (const filePath of publishedArtifacts) {
      changedFiles.add(filePath);
      publicArtifacts.add(filePath);
      artifacts.add(filePath);
    }

    let publishedScriptPath = finalAttempt.scriptPath;
    if (publishedScriptPath && isSubpath(publishedScriptPath, runDir)) {
      const candidate = path.join(finalAttempt.publicDir, path.relative(runDir, publishedScriptPath));
      if (await fileExists(candidate)) {
        publishedScriptPath = candidate;
      }
    }

    const rewrittenRunCommand = rewriteCommandScriptPath(
      finalAttempt.runCommand,
      finalAttempt.originalScriptPath,
      publishedScriptPath
    );
    const rewrittenTestCommand = taskSpec.context.topic_probe_compute_contract
      ? undefined
      : rewriteCommandScriptPath(
          finalAttempt.testCommand || "",
          finalAttempt.originalScriptPath,
          publishedScriptPath
        ) || undefined;
    const workspaceChangedFiles = collectWorkspaceChangedFiles({
      changedFiles: [...changedFiles],
      workspaceRoot: this.deps.workspaceRoot,
      publicDir: finalAttempt.publicDir
    });
    const workspaceChangedManifestPath = path.join(finalAttempt.publicDir, "workspace_changed_files.json");
    await writeJsonFile(workspaceChangedManifestPath, {
      workspace_root: this.deps.workspaceRoot,
      files: workspaceChangedFiles,
      updated_at: new Date().toISOString()
    });
    publicArtifacts.add(workspaceChangedManifestPath);
    artifacts.add(workspaceChangedManifestPath);
    const summary = formatImplementSummary(
      alignImplementSummaryWithPlannedConditionContract(
        finalAttempt.summary,
        taskSpec.context.planned_condition_contract
      ),
      finalAttempt.experimentMode,
      finalAttempt.verifyReport
    );

    const latestRun = (await this.deps.runStore.getRun(run.id)) || run;
    if (activeThreadId && latestRun.nodeThreads.implement_experiments !== activeThreadId) {
      latestRun.nodeThreads.implement_experiments = activeThreadId;
      await this.deps.runStore.updateRun(latestRun);
    }

    const finalLocalization =
      finalAttempt.localization.selected_files.length > 0 || finalAttempt.localization.candidates.length > 0
        ? finalAttempt.localization
        : mergeLocalizationResults(
            latestSearchLocalization,
            undefined,
            inferLocalizationFromArtifacts({
              changedFiles: [...changedFiles],
              scriptPath: publishedScriptPath,
              publicDir: finalAttempt.publicDir
            })
          );
    const finalVerifyReport = {
      ...finalAttempt.verifyReport,
      command: rewrittenTestCommand || finalAttempt.verifyReport.command
    };
    const baseAutoHandoff = shouldAutoHandoffToRunExperiments(finalVerifyReport);
    const autoHandoffToRunExperiments = baseAutoHandoff && !(taskSpec.context.plan_changed && workspaceChangedFiles.length === 0);
    const handoffReason = autoHandoffToRunExperiments
      ? buildRunExperimentsHandoffReason(finalVerifyReport)
      : undefined;
    const savedLongTermMemory =
      finalVerifyReport.status === "pass"
        ? await saveSuccessfulImplementationMemory(longTermStore, {
            run,
            attempt: finalAttempt,
            taskSpec,
            verifyReport: finalVerifyReport,
            localization: finalLocalization
          })
        : undefined;
    const finalLongTermMemory: LongTermMemorySnapshot = {
      search_queries: taskSpec.context.long_term_memory.search_queries,
      retrieved: taskSpec.context.long_term_memory.retrieved,
      saved: savedLongTermMemory
    };
    if (savedLongTermMemory) {
      emitImplementObservation("publish", `Saved long-term implementation lesson ${savedLongTermMemory.id}.`, {
        threadId: activeThreadId,
        publicDir: finalAttempt.publicDir,
        scriptPath: publishedScriptPath,
        runCommand: rewrittenRunCommand,
        testCommand: rewrittenTestCommand
      });
    }

    await runContext.put("implement_experiments.thread_id", activeThreadId);
    await runContext.put("implement_experiments.task_spec", taskSpec);
    await runContext.put("implement_experiments.plan_hash", taskSpec.context.plan_hash);
    await runContext.put("implement_experiments.long_term_memory", finalLongTermMemory);
    await runContext.put("implement_experiments.long_term_entry", savedLongTermMemory || null);
    await runContext.put("implement_experiments.auto_handoff_to_run_experiments", autoHandoffToRunExperiments);
    await runContext.put("implement_experiments.pending_handoff_to_run_experiments", autoHandoffToRunExperiments);
    await runContext.put("implement_experiments.handoff_reason", handoffReason || null);
    await runContext.put("implement_experiments.localization", finalLocalization);
    await runContext.put("implement_experiments.search_localization", latestSearchLocalization);
    await runContext.put("implement_experiments.current_branch", finalAttempt.branchPlan);
    await runContext.put("implement_experiments.branch_history", attemptRecords.map((record) => record.branch_plan));
    await runContext.put("implement_experiments.recent_reflections", recentReflections);
    await runContext.put("implement_experiments.attempts", attemptRecords);
    await runContext.put("implement_experiments.attempt_count", attemptRecords.length);
    await runContext.put("implement_experiments.verify_report", finalVerifyReport);
    await runContext.put("implement_experiments.failure_type", finalVerifyReport.failure_type);
    await runContext.put("implement_experiments.run_command", rewrittenRunCommand);
    await runContext.put("implement_experiments.test_command", rewrittenTestCommand);
    await runContext.put(
      "implement_experiments.requested_gpu_count",
      finalAttempt.requestedGpuCount ?? null
    );
    await runContext.put("implement_experiments.changed_files", [...changedFiles]);
    await runContext.put("implement_experiments.artifacts", [...artifacts]);
    await runContext.put("implement_experiments.public_dir", finalAttempt.publicDir);
    await runContext.put("implement_experiments.public_artifacts", [...publicArtifacts]);
    await runContext.put("implement_experiments.workspace_changed_files", workspaceChangedFiles);
    await runContext.put("implement_experiments.mode", finalAttempt.experimentMode);
    await runContext.put("implement_experiments.llm_profile", experimentLlmProfile);
    await runContext.put("implement_experiments.metrics_path", finalAttempt.metricsPath);
    await runContext.put("implement_experiments.script", publishedScriptPath);
    await runContext.put("implement_experiments.cwd", finalAttempt.workingDir);
    await runContext.put("implement_experiments.last_summary", summary);
    await runContext.put("implement_experiments.raw_response", finalAttempt.rawResponse);
    await runContext.put("implement_experiments.assumptions", finalAttempt.assumptions);
    await runContext.put(
      "implement_experiments.design_implementation_validation",
      finalDesignImplementationValidation
    );
    const candidateIsolationReport: CandidateIsolationReport = {
      version: 1,
      run_id: run.id,
      requested_strategy: requestedIsolationStrategy,
      final_strategy:
        candidateIsolationAttempts.at(-1)?.effective_strategy || requestedIsolationStrategy,
      fallback_occurred: candidateIsolationAttempts.some((attempt) => Boolean(attempt.fallback_from)),
      attempts: candidateIsolationAttempts,
      updated_at: new Date().toISOString()
    };
    await runContext.put("implement_experiments.candidate_isolation_report", candidateIsolationReport);
    const comparisonContract = await loadExperimentComparisonContract(run, runContext);
    const implementationContext = comparisonContract
      ? buildExperimentImplementationContext({
          contract: comparisonContract,
          branchPlan: finalAttempt.branchPlan,
          changedFiles: [...changedFiles],
          scriptPath: publishedScriptPath,
          runCommand: rewrittenRunCommand,
          testCommand: rewrittenTestCommand,
          workingDir: finalAttempt.workingDir,
          threadId: activeThreadId,
          candidateIsolationStrategy: candidateIsolationReport.final_strategy,
          requestedCandidateIsolationStrategy: candidateIsolationReport.requested_strategy,
          fallbackFrom: candidateIsolationAttempts.at(-1)?.fallback_from,
          fallbackReason: candidateIsolationAttempts.at(-1)?.fallback_reason,
          restoredAttempts: restoredAttemptCount,
          snapshotRoot: candidateIsolationAttempts.at(-1)?.snapshot_root,
          worktreePath: candidateIsolationAttempts.at(-1)?.worktree_path,
          cleanupStatus: candidateIsolationAttempts.at(-1)?.cleanup_status,
          orphanedResidueDetected: candidateIsolationAttempts.some(
            (attempt) => attempt.orphaned_residue_paths.length > 0
          )
        })
      : undefined;
    if (implementationContext) {
      await storeExperimentGovernanceDecision(run, runContext, {
        implementationContext,
        candidateIsolationReport,
        designImplementationValidation: finalDesignImplementationValidation,
        entries: []
      });
      await runContext.put(EXPERIMENT_GOVERNANCE_IMPLEMENTATION_CONTEXT_KEY, implementationContext);
    } else {
      await storeExperimentGovernanceDecision(run, runContext, {
        candidateIsolationReport,
        designImplementationValidation: finalDesignImplementationValidation,
        entries: []
      });
    }
    await runContext.put(
      EXPERIMENT_GOVERNANCE_DESIGN_IMPLEMENTATION_VALIDATION_KEY,
      finalDesignImplementationValidation
    );

    await ensureDir(runDir);
    await writeJsonFile(path.join(runDir, "implement_task_spec.json"), taskSpec);
    await writeJsonFile(path.join(runDir, "long_term_memory_result.json"), finalLongTermMemory);
    await writeJsonFile(path.join(runDir, "localization_search_result.json"), latestSearchLocalization || {});
    await writeJsonFile(path.join(runDir, "branch_search_result.json"), {
      branches: attemptRecords.map((record) => ({
        attempt: record.attempt,
        branch_plan: record.branch_plan,
        verify_report: record.verify_report,
        reflection_id: record.reflection?.episode_id
      })),
      recent_reflections: recentReflections
    });
    await writeJsonFile(path.join(runDir, "localization_result.json"), finalLocalization);
    await writeJsonFile(path.join(runDir, "verify_report.json"), finalVerifyReport);
    await writeJsonFile(path.join(runDir, "implement_attempts.json"), {
      attempts: attemptRecords
    });
    await writeJsonFile(
      path.join(runDir, "experiment_governance", "candidate_isolation_report.json"),
      candidateIsolationReport
    );
    await writeJsonFile(path.join(runDir, "implement_result.json"), {
      thread_id: activeThreadId,
      summary,
      experiment_mode: finalAttempt.experimentMode,
      run_command: rewrittenRunCommand,
      test_command: rewrittenTestCommand,
      requested_gpu_count: finalAttempt.requestedGpuCount,
      working_dir: finalAttempt.workingDir,
      public_dir: finalAttempt.publicDir,
      public_artifacts: [...publicArtifacts],
      llm_profile: experimentLlmProfile,
      metrics_path: finalAttempt.metricsPath,
      script_path: publishedScriptPath,
      changed_files: [...changedFiles],
      artifacts: [...artifacts],
      branch_plan: finalAttempt.branchPlan,
      localization: finalLocalization,
      assumptions: finalAttempt.assumptions,
      verify_report: finalVerifyReport,
      design_implementation_validation: finalDesignImplementationValidation,
      auto_handoff_to_run_experiments: autoHandoffToRunExperiments,
      handoff_reason: handoffReason,
      attempt_count: attemptRecords.length,
      raw_response: finalAttempt.rawResponse,
      raw_event_count: rawEvents.length,
      updated_at: new Date().toISOString()
    });
    const artifactRunDir = normalizeFsPath(runDir);
    const intermediateArtifactCapture = await buildIntermediateArtifactCaptureManifest({
      runId: run.id,
      runDir: artifactRunDir,
      node: "implement_experiments",
      phase: "finalize",
      status: finalVerifyReport.status,
      artifacts: [
        {
          artifactId: "implement_task_spec",
          relativePath: "implement_task_spec.json",
          role: "diagnostic",
          required: true,
          parseAs: "json"
        },
        {
          artifactId: "implement_result",
          relativePath: "implement_result.json",
          role: "candidate_output",
          required: true,
          parseAs: "json"
        },
        {
          artifactId: "verify_report",
          relativePath: "verify_report.json",
          role: "verification",
          required: true,
          parseAs: "json"
        },
        {
          artifactId: "implement_attempts",
          relativePath: "implement_attempts.json",
          role: "diagnostic",
          required: true,
          parseAs: "json"
        },
        {
          artifactId: "partial_response",
          relativePath: IMPLEMENT_PARTIAL_RESPONSE_ARTIFACT,
          role: "partial",
          required: false,
          parseAs: "text"
        },
        {
          artifactId: "progress_log",
          relativePath: IMPLEMENT_PROGRESS_LOG_ARTIFACT,
          role: "log",
          required: false,
          parseAs: "jsonl"
        },
        {
          artifactId: "published_script",
          filePath: publishedScriptPath ? normalizeFsPath(publishedScriptPath) : publishedScriptPath,
          role: "candidate_output",
          required: finalVerifyReport.status === "pass",
          parseAs: "text"
        },
        {
          artifactId: "metrics",
          filePath: finalAttempt.metricsPath ? normalizeFsPath(finalAttempt.metricsPath) : finalAttempt.metricsPath,
          role: "metric",
          required: false,
          parseAs: "json",
          notes: ["Metrics remain diagnostic until run_experiments verifies execution."]
        }
      ]
    });
    const intermediateArtifactCapturePath = path.join(runDir, "implement_experiments", "intermediate_artifacts.json");
    const intermediateArtifactCaptureSourcePath = normalizeFsPath(intermediateArtifactCapturePath);
    await writeJsonFile(intermediateArtifactCapturePath, intermediateArtifactCapture);
    await runContext.put("implement_experiments.intermediate_artifact_capture", intermediateArtifactCapture);

    const publicOutputs = await publishPublicRunOutputs({
      workspaceRoot: this.deps.workspaceRoot,
      run,
      node: "implement_experiments",
      runContext,
      section: "experiment",
      files: [
        ...[...publicArtifacts].map((filePath) => ({
          sourcePath: filePath
        })),
        {
          sourcePath: intermediateArtifactCaptureSourcePath,
          targetRelativePath: "implement_experiments_intermediate_artifacts.json"
        }
      ],
      workspaceChangedFiles
    });
    emitImplementObservation("publish", `Public experiment outputs are available at ${publicOutputs.sectionDirRelative}.`, {
      threadId: activeThreadId,
      publicDir: finalAttempt.publicDir,
      scriptPath: publishedScriptPath,
      runCommand: rewrittenRunCommand,
      testCommand: rewrittenTestCommand,
      verificationCommand: finalVerifyReport.command,
      verifyStatus: finalVerifyReport.status
    });

    await flushProgressUpdates();
    await writeImplementProgressStatus(runDir, {
      status: finalVerifyReport.status === "fail" ? "failed" : "completed",
      stage: finalVerifyReport.status === "fail" ? "failed" : "completed",
      message: finalVerifyReport.status === "fail" ? finalVerifyReport.summary : summary,
      startedAt,
      updatedAt: new Date().toISOString(),
      progressCount,
      maxAttempts: MAX_IMPLEMENT_ATTEMPTS,
      threadId: activeThreadId,
      publicDir: finalAttempt.publicDir,
      scriptPath: publishedScriptPath,
      runCommand: rewrittenRunCommand,
      testCommand: rewrittenTestCommand,
      verificationCommand: finalVerifyReport.command,
      verifyStatus: finalVerifyReport.status
    });

    if (finalVerifyReport.status === "fail") {
      throw new Error(finalVerifyReport.summary);
    }

    return {
      summary,
      threadId: activeThreadId,
      runCommand: rewrittenRunCommand,
      testCommand: rewrittenTestCommand,
      scriptPath: publishedScriptPath,
      metricsPath: finalAttempt.metricsPath,
      workingDir: finalAttempt.workingDir,
      experimentMode: finalAttempt.experimentMode,
      publicDir: finalAttempt.publicDir,
      changedFiles: [...changedFiles],
      artifacts: [...artifacts],
      publicArtifacts: [...publicArtifacts],
      rawResponse: finalAttempt.rawResponse,
      verifyReport: finalVerifyReport,
      autoHandoffToRunExperiments,
      handoffReason,
      requestedGpuCount: finalAttempt.requestedGpuCount
    };
  }

  private buildSystemPrompt(
    runDir: string,
    publicDir: string,
    metricsPath: string,
    experimentLlmProfile: ReturnType<typeof resolveExperimentLlmProfile>,
    sessionMode: "codex_native" | "staged_llm",
    environmentSnapshot?: EnvironmentSnapshot,
    topicProbeComputeContract?: ImplementTopicProbeComputeContract
  ): string {
    const sandboxRunDir = rewriteWorkspacePathsForSandbox(runDir, this.deps.workspaceRoot);
    const sandboxPublicDir = rewriteWorkspacePathsForSandbox(publicDir, this.deps.workspaceRoot);
    const sandboxMetricsPath = rewriteWorkspacePathsForSandbox(metricsPath, this.deps.workspaceRoot);
    const environmentBlock = formatEnvironmentSnapshotBlock(environmentSnapshot);
    const topicProbeComputeBlock = formatTopicProbeComputePromptBlock(topicProbeComputeContract);
    return [
      ...environmentBlock,
      ...topicProbeComputeBlock,
      "You are the AutoLabOS implementer role.",
      sessionMode === "codex_native"
        ? "Work directly in the workspace using Codex tools."
        : "You cannot edit files directly. Return full file contents in file_edits so AutoLabOS can materialize the implementation exactly as specified.",
      "Prefer concrete, runnable changes over prose.",
      "Do not modify git history or perform destructive cleanup.",
      `Private AutoLabOS run artifact directory: ${sandboxRunDir}`,
      `Preferred public experiment directory: ${sandboxPublicDir}`,
      `The experiment execution must produce JSON metrics at: ${sandboxMetricsPath}`,
      `Configured real-execution LLM: provider=${experimentLlmProfile.provider}, model=${experimentLlmProfile.model}, reasoning=${experimentLlmProfile.reasoningEffort}, fast_mode=${experimentLlmProfile.fastMode ? "true" : "false"}`,
      "CRITICAL — GPU / device selection (MUST follow for any ML experiment):",
      "Every generated Python script that loads a neural network or language model MUST:",
      "1. Detect the device at startup: device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')",
      "2. Load models onto the detected device: model = AutoModelForCausalLM.from_pretrained(..., device_map='auto', torch_dtype=torch.float16) if CUDA is available, or model.to(device) after loading.",
      "3. Move input tensors to the same device before inference: inputs = {k: v.to(device) for k, v in inputs.items()}",
      "4. Log device info in metrics: torch.cuda.get_device_name(0), torch.cuda.max_memory_allocated().",
      "5. NEVER hardcode CPU-only execution. NEVER omit .to(device) or device_map. Using CPU when a GPU is available is a critical performance bug.",
      "Put reusable code, configs, READMEs, and documentation in the public experiment directory whenever possible.",
      "Use the private run artifact directory only for AutoLabOS metadata, logs, and required metric outputs.",
      "When loading Hugging Face model or tokenizer assets, prefer the standard/global Hugging Face cache unless the task explicitly requires an isolated cache.",
      "Do not set model/tokenizer cache_dir to the public experiment directory or private run artifact directory if that would force a redownload of assets already available in the standard cache.",
      "If required model assets are unavailable locally and a network download is needed, preflight that dependency and emit an explicit dependency failure instead of silently hanging or reporting success metrics.",
      "If a completed condition will be evaluated after training, keep evaluator-required runtime handles in the in-memory condition state until evaluation finishes, or implement an explicit reload path from saved artifacts before scoring.",
      "If evaluation reloads a trained condition artifact, persist a valid per-condition artifact directory, carry that explicit path in the condition state, and never default the reload path to the process cwd or '.' when the artifact path is missing.",
      "When constructing argparse.Namespace/runtime config objects, populate neutral path aliases before condition execution: output_dir, public_dir, run_artifact_dir, artifact_dir, artifacts_dir, condition_output_dir, condition_dir, metrics_path, and artifact_paths should resolve from the same explicit path contract rather than being accessed as optional missing attributes.",
      "Before calling data loaders or task/example materializers, inspect or adapt their signatures and pass required runtime context through supported keyword aliases such as runtime, runtime_context, run_context, config, runtime_config, args, and paths; do not treat a loader failure from a dropped runtime argument as missing data.",
      "Before calling a condition runner, inspect or adapt its signature and pass required runtime context through supported keyword aliases such as runtime, runtime_context, run_context, config, runtime_config, and shared_context; do not call a condition runner after silently dropping a required runtime argument.",
      "Before calling an evaluator, inspect or adapt its signature and pass required condition state/result, data/task bundle, runtime context, and artifact-path arguments through supported keyword aliases; do not call an evaluator after silently dropping a required state argument.",
      "Treat train-complete states such as completed_training, training_completed, trained, success, succeeded, and ok as eligible for evaluation; do not let an evaluator skip them as not completed before objective metrics are computed.",
      "Do not write train-only completed_training rows as final condition evidence: every successful condition_result must include populated objective task_metrics or an explicit evaluation failure before metrics.json is finalized.",
      "Training-example normalizers must preserve usable instruction/training text from mapping/object/dataclass records with common fields such as instruction, input, output, prompt, response, text, question, answer, messages, and conversations; if loaded records normalize to zero usable texts, fail at data_access with schema diagnostics instead of entering condition execution.",
      "Evaluation normalizers must preserve objective targets from the dataset schema; if requested evaluation examples exist but the governed objective observations are absent, emit schema diagnostics and repair normalization instead of reporting completed evidence.",
      "Metrics JSON must contain a ResultsArtifactV2 that matches ExperimentContract.results_plan exactly: preserve declared metric ids, directions, units, series roles, observation links, and comparison ids without inferring them from labels, order, or values; omit runtime-only objects such as model/tokenizer from serialized results.",
      "Before calling save_pretrained on generated model artifacts, normalize non-JSON-safe dtype/config fields to primitive strings so artifact saving cannot fail during JSON serialization.",
      "For long-running repeated-run real_execution, create node-owned observability artifacts before the main loop: write progress or heartbeat JSONL plus partial metrics at data-load, model-load, each condition/seed start, each condition/seed finish, and failure boundaries, flushing writes so run_experiments can distinguish progress from a hang.",
      "Prefer real executable experiments against actual repo code, benchmarks, and model calls when the workspace supports them.",
      "Use a synthetic validation harness only as a fallback when a real execution path is impossible or clearly underspecified.",
      "For real_execution handoff, do not make deterministic, simulated, smoke, or fallback metrics satisfy the primary experiment. If real execution cannot run, emit explicit failure diagnostics or mark the bundle synthetic_validation; never present fallback output as training or benchmark evidence.",
      "Do not plan deterministic, simulated, smoke, cached, or fallback corpora as success-producing primary evidence; such paths must not populate completed_run_count, completed_condition_count, baseline deltas, or primary metric fields as if real execution occurred.",
      "Before editing, identify the smallest viable set of files to inspect or change.",
      "Return ONLY one JSON object with keys: summary, experiment_mode, run_command, test_command, requested_gpu_count, working_dir, changed_files, artifacts, public_dir, public_artifacts, script_path, metrics_path, localization, assumptions, file_edits.",
      "Use experiment_mode = real_execution | hybrid_validation | synthetic_validation.",
      "changed_files, artifacts, and public_artifacts must be arrays of workspace paths.",
      "List only artifacts materialized during implement_experiments in changed_files, artifacts, and public_artifacts; do not list deferred runtime outputs such as metrics_path, results*.json, *_results.json, study_results.json, latest_results.json, or run.log unless you actually write them now.",
      "file_edits must be an array of objects with keys: path, content.",
      "localization must be an object with keys: summary, strategy, reasoning, selected_files, candidate_files, confidence.",
      "candidate_files must be an array of objects with keys: path, symbol, reason, confidence."
    ].join("\n");
  }

  private async buildTaskSpec(
    run: RunRecord,
    runDir: string,
    publicDir: string,
    metricsPath: string,
    runContext: RunContextMemory,
    longTermMemory: LongTermMemorySnapshot,
    environmentSnapshot?: EnvironmentSnapshot
  ): Promise<ImplementTaskSpec> {
    const plan = trimBlock(await safeRead(path.join(runDir, "experiment_plan.yaml")), 12_000);
    const frozenRunBrief = await runContext.get<string>("run_brief.raw");
    const workspaceBrief = await safeRead(path.join(this.deps.workspaceRoot, "Brief.md"));
    const brief = trimBlock(frozenRunBrief || workspaceBrief, 12_000);
    const planHash = plan ? createHash("sha256").update(plan).digest("hex").slice(0, 16) : "";
    const previousPlanHash = await runContext.get<string>("implement_experiments.plan_hash");
    const planChanged = !!(plan && previousPlanHash && planHash !== previousPlanHash);
    const hypotheses = trimBlock(await safeRead(path.join(runDir, "hypotheses.jsonl")), 12_000);
    const previousSummary = await runContext.get<string>("implement_experiments.last_summary");
    const previousRunCommand = await runContext.get<string>("implement_experiments.run_command");
    const previousScript = await runContext.get<string>("implement_experiments.script");
    const normalizedPreviousScript = normalizeStoredPath(previousScript, this.deps.workspaceRoot);
    const previousScriptExists = normalizedPreviousScript ? await fileExists(normalizedPreviousScript) : true;
    const stalePreviousImplementation =
      normalizedPreviousScript && !previousScriptExists
        ? {
            previous_script: previousScript,
            previous_run_command: previousRunCommand,
            reason:
              "The previously persisted implementation script is missing from the workspace; regenerate the public experiment bundle instead of repairing that stale path in place."
          }
        : undefined;
    const promptPreviousRunCommand = stalePreviousImplementation ? undefined : previousRunCommand;
    const promptPreviousScript = stalePreviousImplementation ? undefined : previousScript;
    const runnerFeedback = await this.loadApplicableRunnerFeedback(run, runContext);
    const priorRunFailureConstraints = await loadPriorRunFailureConstraints(runDir, runnerFeedback);
    const implementationContractFeedback = await this.loadApplicableImplementationContractFeedback(runContext);
    const paperCritique = await runContext.get<{
      overall_decision?: string;
      manuscript_type?: string;
      needs_additional_experiments?: boolean;
      manuscript_claim_risk_summary?: string;
      blocking_issues?: Array<{ summary?: string; recommended_fix?: string }>;
    }>("write_paper.paper_critique");
    const paperCritiqueFeedback =
      paperCritique?.needs_additional_experiments || paperCritique?.overall_decision === "backtrack_to_implement"
        ? {
            overall_decision: paperCritique.overall_decision,
            manuscript_type: paperCritique.manuscript_type,
            needs_additional_experiments: paperCritique.needs_additional_experiments,
            blocking_issue_summaries: (paperCritique.blocking_issues || [])
              .map((item) => trimBlock(item.summary || "", 240))
              .filter(Boolean)
              .slice(0, 6),
            recommended_fixes: (paperCritique.blocking_issues || [])
              .map((item) => trimBlock(item.recommended_fix || "", 240))
              .filter(Boolean)
              .slice(0, 6),
            summary: trimBlock(paperCritique.manuscript_claim_risk_summary || "", 500)
          }
        : undefined;
    const cachedConstraintProfile = await runContext.get<CachedConstraintProfile>("constraints.profile");
    const comparisonContract = await loadExperimentComparisonContract(run, runContext);
    const topicProbeComputeContract = await loadImplementTopicProbeComputeContract({
      workspaceRoot: this.deps.workspaceRoot,
      run,
      runDir,
      rawBrief: frozenRunBrief
    });
    const estimatorGate = await runContext.get<PersistedEstimatorFeasibilityGate>(
      "research_governance.estimator_feasibility_gate"
    );
    const executionAuthorizationGate = await runContext.get<
      TopicProbeExecutionAuthorizationGateArtifact
    >("research_governance.topic_probe_execution_authorization");
    const estimatorFeasibility = estimatorGate
      ? compactEstimatorFeasibilityForImplementation(estimatorGate)
      : undefined;
    const plannedConditionContract = derivePlannedConditionContract({
      plan,
      brief,
      preferBriefContract: Boolean(frozenRunBrief),
      objectiveMetric: run.objectiveMetric
    });
    const dependencyRepairContext = deriveImplementDependencyRepairContext({
      plan,
      runnerFeedback
    });
    const repoListing = await topLevelWorkspaceListing(this.deps.workspaceRoot);
    const sandboxWorkspaceRoot = toSandboxFriendlyWorkspaceRoot(this.deps.workspaceRoot);
    const sandboxRunDir = rewriteWorkspacePathsForSandbox(runDir, this.deps.workspaceRoot);
    const sandboxPublicDir = rewriteWorkspacePathsForSandbox(publicDir, this.deps.workspaceRoot);
    const sandboxMetricsPath = rewriteWorkspacePathsForSandbox(metricsPath, this.deps.workspaceRoot);

    return {
      goal: `Implement a runnable experiment for "${run.topic}" and produce metrics for ${run.objectiveMetric}.`,
      acceptance_criteria: [
        "Return a runnable command for the experiment.",
        `Ensure the workflow can write metrics JSON to ${sandboxMetricsPath}.`,
        "Keep reusable scripts, configs, and documentation in the public experiment directory.",
        "Prefer a real execution path over synthetic validation whenever the workspace supports it. For real_execution, deterministic or simulated fallback output must be diagnostic-only and must not be the default success path.",
        ...(topicProbeComputeContract
          ? [
              "Write metrics.compute_usage exactly according to context.topic_probe_compute_contract.compute_usage_schema, including no additional fields.",
              "Return requested_gpu_count as the non-negative integer GPU count that the run command will actually request; do not copy the active cap unless the command truly requests that count.",
              `Keep requested_gpu_count at or below the active ${topicProbeComputeContract.stage} limit of ${topicProbeComputeContract.active_limit.max_concurrent_gpus}.`
            ]
          : []),
        ...(estimatorFeasibility
          ? [
              "Implement the exact estimator units, arms, primary contrast, pairing, and analysis family declared in context.estimator_feasibility; do not substitute a prose-inferred analysis.",
              "Preserve the estimator contract bindings and write raw outputs at the declared outcome and analysis units so downstream verification can recompute the primary comparison."
            ]
          : [])
      ],
      non_goals: [
        "Do not rewrite git history or perform destructive cleanup.",
        "Do not redesign unrelated project structure.",
        "Do not place reusable artifacts only in the private run directory."
      ],
      constraints: [
        ...run.constraints,
        `required_metrics_path=${sandboxMetricsPath}`
      ],
      workspace: {
        root: sandboxWorkspaceRoot,
        run_dir: sandboxRunDir,
        public_dir: sandboxPublicDir,
        metrics_path: sandboxMetricsPath
      },
      execution: {
        runner: this.deps.config.experiments.runner,
        timeout_sec: this.deps.config.experiments.timeout_sec
      },
      context: {
        topic: run.topic,
        topic_probe_execution_authorization: executionAuthorizationGate
          ? {
              status: executionAuthorizationGate.status,
              effective_execution_authorized:
                executionAuthorizationGate.effective_execution_authorized,
              content_sha256: executionAuthorizationGate.content_sha256
            }
          : undefined,
        objective_metric: run.objectiveMetric,
        plan_excerpt: rewriteWorkspacePathsForSandbox(plan || "(missing)", this.deps.workspaceRoot),
        hypotheses_excerpt: rewriteWorkspacePathsForSandbox(hypotheses || "(missing)", this.deps.workspaceRoot),
        repo_listing: repoListing,
        previous_summary: rewriteWorkspacePathsForSandbox(previousSummary, this.deps.workspaceRoot),
        previous_run_command: rewriteWorkspacePathsForSandbox(promptPreviousRunCommand, this.deps.workspaceRoot),
        previous_script: rewriteWorkspacePathsForSandbox(promptPreviousScript, this.deps.workspaceRoot),
        stale_previous_implementation: rewriteWorkspacePathsForSandbox(
          stalePreviousImplementation,
          this.deps.workspaceRoot
        ),
        environment_snapshot: rewriteWorkspacePathsForSandbox(environmentSnapshot, this.deps.workspaceRoot),
        long_term_memory: rewriteWorkspacePathsForSandbox(longTermMemory, this.deps.workspaceRoot),
        implementation_contract_feedback: rewriteWorkspacePathsForSandbox(
          implementationContractFeedback,
          this.deps.workspaceRoot
        ),
        runner_feedback: rewriteWorkspacePathsForSandbox(runnerFeedback, this.deps.workspaceRoot),
        prior_run_failure_constraints: rewriteWorkspacePathsForSandbox(
          priorRunFailureConstraints,
          this.deps.workspaceRoot
        ),
        paper_critique_feedback: rewriteWorkspacePathsForSandbox(
          paperCritiqueFeedback,
          this.deps.workspaceRoot
        ),
        resolved_constraint_profile: rewriteWorkspacePathsForSandbox(cachedConstraintProfile?.profile, this.deps.workspaceRoot),
        dependency_repair_context: dependencyRepairContext,
        comparison_contract: comparisonContract
          ? rewriteWorkspacePathsForSandbox(
              {
                plan_id: comparisonContract.plan_id,
                comparison_mode: comparisonContract.comparison_mode,
                baseline_first_required: comparisonContract.baseline_first_required,
                baseline_candidate_ids: comparisonContract.baseline_candidate_ids,
                budget_profile: comparisonContract.budget_profile,
                evaluator_contract_id: comparisonContract.evaluator_contract_id
              },
              this.deps.workspaceRoot
            )
          : undefined,
        estimator_feasibility: estimatorFeasibility,
        topic_probe_compute_contract: topicProbeComputeContract,
        planned_condition_contract: plannedConditionContract,
        plan_changed: planChanged,
        plan_hash: planHash
      }
    };
  }

  private async loadApplicableImplementationContractFeedback(
    runContext: RunContextMemory
  ): Promise<ImplementationContractFeedback | undefined> {
    const verifyReport = await runContext.get<VerifyReport>("implement_experiments.verify_report");
    const validation =
      (await runContext.get<ExperimentDesignImplementationValidationReport>(
        "implement_experiments.design_implementation_validation"
      )) ||
      (await runContext.get<ExperimentDesignImplementationValidationReport>(
        EXPERIMENT_GOVERNANCE_DESIGN_IMPLEMENTATION_VALIDATION_KEY
      ));
    return buildImplementationContractFeedback(verifyReport, validation);
  }

  private async loadApplicableRunnerFeedback(
    run: RunRecord,
    runContext: RunContextMemory
  ): Promise<RunVerifierReport | undefined> {
    const runnerFeedback =
      (await runContext.get<RunVerifierReport>("implement_experiments.runner_feedback")) ||
      (await runContext.get<RunVerifierReport>("run_experiments.feedback_for_implementer"));
    if (!runnerFeedback) {
      return undefined;
    }
    const feedbackRecordedAt = Date.parse(runnerFeedback.recorded_at || "");
    const implementUpdatedAt = Date.parse(run.graph.nodeStates.implement_experiments?.updatedAt || "");
    const implementStatus = run.graph.nodeStates.implement_experiments?.status;
    const implementAlreadySucceeded =
      implementStatus === "completed" || implementStatus === "needs_approval";
    const latestImplementVerifyReport = await runContext.get<VerifyReport>("implement_experiments.verify_report");
    const implementHasNewerLocalFailure =
      Number.isFinite(feedbackRecordedAt) &&
      Number.isFinite(implementUpdatedAt) &&
      implementUpdatedAt > feedbackRecordedAt &&
      (implementStatus === "failed" || implementStatus === "running") &&
      latestImplementVerifyReport?.status === "fail" &&
      latestImplementVerifyReport.next_action === "retry_patch";
    if (implementHasNewerLocalFailure) {
      return undefined;
    }
    if (
      Number.isFinite(feedbackRecordedAt) &&
      Number.isFinite(implementUpdatedAt) &&
      implementUpdatedAt > feedbackRecordedAt &&
      implementAlreadySucceeded
    ) {
      await runContext.put("implement_experiments.runner_feedback", null);
      await runContext.put("run_experiments.feedback_for_implementer", null);
      return undefined;
    }
    if (run.graph.nodeStates.run_experiments?.status === "failed") {
      return runnerFeedback;
    }
    const designUpdatedAt = Date.parse(run.graph.nodeStates.design_experiments?.updatedAt || "");
    if (
      Number.isFinite(feedbackRecordedAt) &&
      Number.isFinite(designUpdatedAt) &&
      designUpdatedAt > feedbackRecordedAt
    ) {
      await runContext.put("implement_experiments.runner_feedback", null);
      await runContext.put("run_experiments.feedback_for_implementer", null);
      return undefined;
    }
    return runnerFeedback;
  }

  private buildAttemptPrompt(params: {
    taskSpec: ImplementTaskSpec;
    searchLocalization: LocalizationResult;
    branchPlan: BranchPlan;
    recentReflections: EpisodeRecord[];
    attempt: number;
    previousAttempt?: AttemptRecord;
    existingChangedFiles: string[];
    historicalChangedFiles: string[];
    sessionMode: "codex_native" | "staged_llm";
  }): string {
    const useCompactApiPrompt = params.sessionMode === "staged_llm";
    const sandboxTaskSpec = rewriteWorkspacePathsForSandbox(params.taskSpec, this.deps.workspaceRoot);
    const sandboxSearchLocalization = rewriteWorkspacePathsForSandbox(params.searchLocalization, this.deps.workspaceRoot);
    const sandboxBranchPlan = rewriteWorkspacePathsForSandbox(params.branchPlan, this.deps.workspaceRoot);
    const sandboxRecentReflections = rewriteWorkspacePathsForSandbox(
      params.recentReflections.map((item) => ({
        attempt: item.attempt,
        error_class: item.error_class,
        lesson: item.lesson,
        next_try_instruction: item.next_try_instruction
      })),
      this.deps.workspaceRoot
    );
    const sandboxExistingChangedFiles = rewriteWorkspacePathsForSandbox(
      params.existingChangedFiles,
      this.deps.workspaceRoot
    );
    const sandboxHistoricalChangedFiles = rewriteWorkspacePathsForSandbox(
      params.historicalChangedFiles,
      this.deps.workspaceRoot
    );
    const sandboxPreviousAttempt = params.previousAttempt
      ? rewriteWorkspacePathsForSandbox(
          {
            verify_report: params.previousAttempt.verify_report,
            localization: params.previousAttempt.localization,
            summary: params.previousAttempt.summary
          },
          this.deps.workspaceRoot
        )
      : undefined;
    const promptTaskSpec = useCompactApiPrompt
      ? compactTaskSpecForStagedLlmPrompt(sandboxTaskSpec)
      : sandboxTaskSpec;
    const promptSearchLocalization = useCompactApiPrompt
      ? compactLocalizationForStagedLlmPrompt(sandboxSearchLocalization)
      : sandboxSearchLocalization;
    const promptBranchPlan = useCompactApiPrompt
      ? compactBranchPlanForStagedLlmPrompt(sandboxBranchPlan)
      : sandboxBranchPlan;
    const promptLongTermMemory = useCompactApiPrompt
      ? compactLongTermMemoryForStagedLlmPrompt(sandboxTaskSpec.context.long_term_memory)
      : sandboxTaskSpec.context.long_term_memory;
    const promptRunnerFeedback = useCompactApiPrompt
      ? compactRunnerFeedbackForStagedLlmPrompt(sandboxTaskSpec.context.runner_feedback)
      : sandboxTaskSpec.context.runner_feedback;
    const promptImplementationContractFeedback = useCompactApiPrompt
      ? compactImplementationContractFeedbackForStagedLlmPrompt(
          sandboxTaskSpec.context.implementation_contract_feedback
        )
      : sandboxTaskSpec.context.implementation_contract_feedback;
    const promptPaperCritiqueFeedback = useCompactApiPrompt
      ? compactPaperCritiqueForStagedLlmPrompt(sandboxTaskSpec.context.paper_critique_feedback)
      : sandboxTaskSpec.context.paper_critique_feedback;
    const promptRecentReflections = useCompactApiPrompt
      ? compactReflectionsForStagedLlmPrompt(sandboxRecentReflections)
      : sandboxRecentReflections;
    const promptExistingChangedFiles = useCompactApiPrompt
      ? compactStringListForStagedLlmPrompt(sandboxExistingChangedFiles, 8)
      : sandboxExistingChangedFiles;
    const promptHistoricalChangedFiles = useCompactApiPrompt
      ? compactStringListForStagedLlmPrompt(sandboxHistoricalChangedFiles, 8)
      : sandboxHistoricalChangedFiles;
    const promptPreviousAttempt = useCompactApiPrompt
      ? compactPreviousAttemptForStagedLlmPrompt(sandboxPreviousAttempt)
      : sandboxPreviousAttempt;
    const lines = [
      `Implementation attempt ${params.attempt}/${MAX_IMPLEMENT_ATTEMPTS}.`,
      "Task spec:",
      JSON.stringify(promptTaskSpec, null, 2),
      "",
      "Implementation protocol:",
      "1. Localize the smallest set of files you need to inspect or edit.",
      "2. Start from the branch focus files unless you find stronger contradictory evidence.",
      "3. Implement the runnable experiment.",
      "4. Provide a lightweight verification command. If nothing else is available, prefer a syntax or compile check.",
      "5. Return only the required JSON object.",
      "",
      "Additional guidance:",
      "Prefer minimal changes and explain localization clearly.",
      "If localization is uncertain, say so in localization.reasoning and candidate_files.",
      "If you create a new script, include it in changed_files and localization.selected_files.",
      "Reuse long-term implementation memory when it directly applies to the current branch focus.",
      "",
      "Hardware / device selection (MANDATORY for all ML scripts):",
      "- At the top of any generated ML script: device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')",
      "- Load models with GPU support: model = AutoModelForCausalLM.from_pretrained(..., device_map='auto', torch_dtype=torch.float16) — this auto-places on GPU.",
      "- If device_map='auto' is not used, MUST call model = model.to(device) immediately after loading.",
      "- Before model.generate() or forward pass, move inputs: inputs = {k: v.to(device) for k, v in inputs.items()}",
      "- Do NOT pass generator= or generation_kwargs['generator'] into model.generate(); seed sampling outside the generate() call instead.",
      "- In metrics output, include: 'device': str(device), 'gpu_name': torch.cuda.get_device_name(0) if available, 'peak_vram_gb': torch.cuda.max_memory_allocated()/1e9.",
      "- FAILURE TO USE GPU WHEN AVAILABLE IS A BLOCKING BUG. CPU inference on a 3B model takes ~17s/example; GPU takes <0.5s/example.",
      "- If an existing script already exists and uses CPU-only, you MUST patch it to use GPU."
    ];
    if (params.sessionMode === "staged_llm") {
      lines.splice(10, 0, "6. This staged_llm attempt uses a scaffold-first contract.");
      lines.splice(11, 0, "7. Return scaffold metadata only in the first response. Do NOT include file contents in the scaffold response.");
      lines.splice(12, 0, "8. Include a compact decomposition_plan in the scaffold: at least one materialize_text_file unit targeting script_path or changed_files; do not include file contents.");
      lines.splice(13, 0, "9. The API-mode context below is compacted to the highest-signal fields only; do not assume omitted fields are required.");
    }

    lines.push("", "Search-backed localization hints:", JSON.stringify(promptSearchLocalization, null, 2));
    lines.push("", "Branch focus:", JSON.stringify(promptBranchPlan, null, 2));
    if (promptLongTermMemory.retrieved.length > 0) {
      lines.push(
        "",
        "Long-term implementation memory:",
        JSON.stringify(promptLongTermMemory, null, 2)
      );
    }
    if (promptRunnerFeedback) {
      lines.push(
        "",
        "Runner feedback from run_experiments:",
        JSON.stringify(promptRunnerFeedback, null, 2)
      );
    }
    if (sandboxTaskSpec.context.prior_run_failure_constraints?.length) {
      lines.push(
        "",
        "Previously observed run_experiments failure constraints:",
        JSON.stringify(sandboxTaskSpec.context.prior_run_failure_constraints, null, 2),
        "",
        "Keep these previously repaired constraints satisfied while fixing the latest runner feedback.",
        "Do not trade one verifier failure for another or remove controls that a prior run already required."
      );
    }
    if (promptImplementationContractFeedback) {
      lines.push(
        "",
        "Implementation contract feedback from implement_experiments:",
        JSON.stringify(promptImplementationContractFeedback, null, 2),
        "",
        "This feedback is a first-stage handoff blocker. Fix it before addressing older runtime feedback.",
        "The next implementation must expose the full planned condition grid and condition-by-seed run schedule in code and metrics.",
        "Keep the repair on the canonical public runnable script selected by Branch focus; do not create or shift to alternate experiment.py/run_* branches unless that focused runner imports them as tiny helpers.",
        "Prefer one public runner plus minimal helper modules over broad multi-file rewrites when the blocker is only PLANNED_CONDITION_COUNT_CONTRACTED or PLANNED_RUN_COUNT_CONTRACTED."
      );
    }
    if (promptPaperCritiqueFeedback) {
      lines.push(
        "",
        "Post-draft critique requiring stronger experimental evidence:",
        JSON.stringify(promptPaperCritiqueFeedback, null, 2),
        "",
        "Treat this as a fresh implementation target. Do NOT reuse the previous script unchanged.",
        "Expand the implementation so the next governed run can add the missing evidence categories called out by the critique when possible within budget."
      );
    }
    if (sandboxTaskSpec.context.comparison_contract) {
      lines.push(
        "",
        "Locked experiment comparison contract:",
        JSON.stringify(sandboxTaskSpec.context.comparison_contract, null, 2),
        "",
        "Do not silently change the comparison metric, baseline binding, or locked budget profile."
      );
    }
    if (sandboxTaskSpec.context.estimator_feasibility) {
      lines.push(
        "",
        "Locked estimator feasibility contract:",
        JSON.stringify(sandboxTaskSpec.context.estimator_feasibility, null, 2),
        "",
        "Implement these units, arms, contrast, pairing, estimator, and multiplicity choices exactly. Emit raw evidence at the declared analysis unit; do not replace this contract with an inferred alternative."
      );
    }
    if (sandboxTaskSpec.context.planned_condition_contract) {
      lines.push(
        "",
        "Planned condition contract:",
        JSON.stringify(sandboxTaskSpec.context.planned_condition_contract, null, 2),
        "",
        "Preserve every planned condition marker in the implementation and metrics; do not collapse named condition families into generic variants.",
        "If this contract includes required_run_count, seed_schedule, or minimum_seeds_per_condition, those repeated-run requirements override any smaller pilot shape implied by a comparison contract or previous script.",
        "Do not compress repeated cells into one aggregate condition marker; materialize per-cell/per-seed execution and aggregate only after raw rows are written.",
        "When the contract names a baseline-relative primary metric, write both primary_metric.name/value and the same top-level metric key in metrics.json, computed from executed baseline/comparator outputs only."
      );
    }

    if (sandboxTaskSpec.context.plan_changed) {
      lines.push(
        "",
        "⚠ CRITICAL: The experiment plan has changed since the last implementation (plan hash mismatch).",
        "You MUST re-implement the experiment script to match the new plan.",
        "Do NOT reuse the previous script unchanged. Read the updated plan_excerpt carefully",
        "and ensure the script reflects the new datasets, conditions, baselines, sample sizes,",
        "and evaluation criteria specified in the current plan.",
        "The previous script is provided only as reference for code patterns, not as a valid implementation."
      );
    }

    if (promptRecentReflections.length > 0) {
      lines.push("", "Recent failure reflections:", JSON.stringify(promptRecentReflections, null, 2));
    }

    if (promptExistingChangedFiles.length > 0) {
      lines.push("", "Files already changed in this workspace:", promptExistingChangedFiles.join("\n"));
    }
    if (promptHistoricalChangedFiles.length > 0) {
      lines.push(
        "",
        "Files touched in previous attempts (now restored unless reintroduced):",
        promptHistoricalChangedFiles.join("\n")
      );
    }

    if (promptPreviousAttempt) {
      lines.push(
        "",
        "Previous local verification:",
        JSON.stringify(promptPreviousAttempt.verify_report, null, 2),
        "",
        "Previous localization:",
        JSON.stringify(promptPreviousAttempt.localization, null, 2),
        "",
        "Previous summary:",
        promptPreviousAttempt.summary
      );
      if (promptPreviousAttempt.verify_report.failure_type === "localization") {
        lines.push("Revisit which files you edit before making another patch.");
      } else if (promptPreviousAttempt.verify_report.failure_type === "implementation") {
        lines.push("Keep the fix focused and address the verification failure directly.");
      }
    }

    return lines.join("\n");
  }

  private buildFilesystemFallbackRecoveryPrompt(params: {
    taskSpec: ImplementTaskSpec;
    searchLocalization: LocalizationResult;
    branchPlan: BranchPlan;
    attempt: number;
  }): string {
    const sandboxTaskSpec = rewriteWorkspacePathsForSandbox(params.taskSpec, this.deps.workspaceRoot);
    const sandboxSearchLocalization = rewriteWorkspacePathsForSandbox(params.searchLocalization, this.deps.workspaceRoot);
    const sandboxBranchPlan = rewriteWorkspacePathsForSandbox(params.branchPlan, this.deps.workspaceRoot);
    const promptTaskSpec = compactTaskSpecForStagedLlmPrompt(sandboxTaskSpec);
    const promptSearchLocalization = compactLocalizationForStagedLlmPrompt(sandboxSearchLocalization);
    const promptBranchPlan = compactBranchPlanForStagedLlmPrompt(sandboxBranchPlan);

    return [
      `Implementation attempt ${params.attempt}/${MAX_IMPLEMENT_ATTEMPTS} (filesystem-blocker recovery mode).`,
      "The previous Codex filesystem/tooling blocker has already been detected and handled by AutoLabOS.",
      "Do NOT repeat the blocker narrative, sandbox explanation, or any request to retry Codex filesystem actions.",
      "Treat this as a fresh staged_llm implementation task and return ONLY one JSON object.",
      "A valid response MUST include non-empty file_edits for every created or modified text artifact needed for the runnable experiment bundle.",
      "At minimum, emit file_edits for the runnable script and any required config or README referenced by your commands.",
      "If inspection is incomplete, synthesize the smallest bounded implementation that satisfies the locked task spec, branch focus, and localization hints.",
      "Task spec:",
      JSON.stringify(promptTaskSpec, null, 2),
      "",
      "Search-backed localization hints:",
      JSON.stringify(promptSearchLocalization, null, 2),
      "",
      "Branch focus:",
      JSON.stringify(promptBranchPlan, null, 2),
      "",
      "Output contract reminder:",
      "- Return ONLY one JSON object with keys: summary, experiment_mode, run_command, test_command, requested_gpu_count, working_dir, changed_files, artifacts, public_dir, public_artifacts, script_path, metrics_path, localization, assumptions, file_edits.",
      "- file_edits must contain full UTF-8 contents for each referenced file.",
      "- changed_files, artifacts, and public_artifacts must list only files materialized during implement_experiments, not deferred runtime outputs such as metrics_path, results*.json, *_results.json, study_results.json, latest_results.json, or run.log.",
      "- Responses that only describe the blocker or omit file_edits are invalid."
    ].join("\n");
  }

  private async completeStagedLlmRequest(input: {
    runDir: string;
    prompt: string;
    systemPrompt: string;
    timeoutMs: number;
    abortSignal?: AbortSignal;
    attempt: number;
    threadId?: string;
    publicDir: string;
    emitImplementObservation: (
      stage: ImplementProgressStage,
      message: string,
      extras?: Partial<ImplementProgressStatus>
    ) => void;
    reasoningEffort?: string;
    maxStreamedChars?: number;
  }): Promise<{ text: string; threadId?: string }> {
    const partialResponsePath = normalizeFsPath(path.join(input.runDir, IMPLEMENT_PARTIAL_RESPONSE_ARTIFACT));
    const heartbeatMs = getImplementLlmProgressHeartbeatMs();
    let partialText = "";
    let lastSnapshotLength = 0;
    let sawProgressEvent = false;
    let sawDeltaEvent = false;
    let lastProgressAt = Date.now();
    let lastDeltaObservationAt = 0;
    let lastDeltaObservationChars = 0;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    const progressStallTimeoutMs = getImplementLlmProgressStallTimeoutMs();
    const progressStallController = progressStallTimeoutMs > 0 ? new AbortController() : undefined;
    const streamedSizeController = input.maxStreamedChars && input.maxStreamedChars > 0
      ? new AbortController()
      : undefined;
    let progressStallTimer: NodeJS.Timeout | undefined;
    let progressStalled = false;
    let streamedSizeExceeded = false;
    const persistPartialSnapshot = async () => {
      if (!partialText.trim()) {
        return;
      }
      await ensureDir(path.dirname(partialResponsePath));
      await fs.writeFile(partialResponsePath, partialText, "utf8");
      lastSnapshotLength = partialText.length;
    };
    const maybePersistPartialSnapshot = async () => {
      if (partialText.length === lastSnapshotLength) {
        return;
      }
      if (partialText.length - lastSnapshotLength < 64 && partialText.length < 256) {
        return;
      }
      await persistPartialSnapshot();
    };
    try {
      await fs.rm(partialResponsePath, { force: true });
    } catch {
      // Best effort only: a stale partial snapshot should never block a provider request.
    }
    const emitDeltaProgressSummary = (force = false) => {
      if (!sawDeltaEvent) {
        return;
      }
      const now = Date.now();
      const charCount = partialText.trim().length;
      if (
        !force &&
        now - lastDeltaObservationAt < IMPLEMENT_DELTA_PROGRESS_MIN_MS &&
        charCount - lastDeltaObservationChars < IMPLEMENT_DELTA_PROGRESS_MIN_CHARS
      ) {
        return;
      }
      lastDeltaObservationAt = now;
      lastDeltaObservationChars = charCount;
      input.emitImplementObservation(
        "codex",
        `LLM streamed ${charCount} chars; partial snapshot updated at ${formatArtifactPath(partialResponsePath)}.`,
        {
          attempt: input.attempt,
          threadId: input.threadId,
          publicDir: input.publicDir
        }
      );
    };
    const timeoutController = input.timeoutMs > 0 ? new AbortController() : undefined;
    const timeoutId = timeoutController
      ? setTimeout(() => timeoutController.abort(), input.timeoutMs)
      : undefined;
    const abortSignals = [
      input.abortSignal,
      timeoutController?.signal,
      progressStallController?.signal,
      streamedSizeController?.signal
    ].filter((signal): signal is AbortSignal => Boolean(signal));
    const llmAbortSignal =
      abortSignals.length === 0
        ? undefined
        : abortSignals.length === 1
          ? abortSignals[0]
          : AbortSignal.any(abortSignals);
    const clearProgressStallTimer = () => {
      if (progressStallTimer) {
        clearTimeout(progressStallTimer);
        progressStallTimer = undefined;
      }
    };
    const scheduleProgressStallTimer = () => {
      if (!progressStallController || progressStallController.signal.aborted) {
        return;
      }
      clearProgressStallTimer();
      progressStallTimer = setTimeout(() => {
        const silenceMs = Date.now() - lastProgressAt;
        const silenceSec = Math.max(1, Math.floor(silenceMs / 1000));
        progressStalled = true;
        input.emitImplementObservation(
          "codex",
          `staged_llm provider stalled for ${silenceSec}s without progress; aborting bounded request.`,
          {
            attempt: input.attempt,
            threadId: input.threadId,
            publicDir: input.publicDir
          }
        );
        progressStallController.abort();
      }, progressStallTimeoutMs);
    };
    if (heartbeatMs > 0) {
      heartbeatTimer = setInterval(() => {
        const silenceMs = Date.now() - lastProgressAt;
        const silenceSec = Math.max(1, Math.floor(silenceMs / 1000));
        const heartbeatMessage = sawProgressEvent
          ? `Still waiting on staged_llm provider output; no new provider progress for ${silenceSec}s.`
          : `Still waiting on staged_llm provider output; no provider progress observed for ${silenceSec}s.`;
        input.emitImplementObservation("codex", heartbeatMessage, {
          attempt: input.attempt,
          threadId: input.threadId,
          publicDir: input.publicDir
        });
      }, heartbeatMs);
    }
    try {
      let completion: { text: string; threadId?: string } | undefined;
      for (let requestAttempt = 1; requestAttempt <= IMPLEMENT_STAGED_LLM_TRANSIENT_RETRY_MAX_ATTEMPTS; requestAttempt += 1) {
        try {
          scheduleProgressStallTimer();
          try {
            completion = await this.deps.llm!.complete(input.prompt, {
              threadId: input.threadId,
              systemPrompt: input.systemPrompt,
              reasoningEffort: input.reasoningEffort,
              abortSignal: llmAbortSignal,
              onProgress: (event) => {
                const text = event.text.trim();
                lastProgressAt = Date.now();
                sawProgressEvent = true;
                scheduleProgressStallTimer();
                if (!text) {
                  return;
                }
                if (event.type === "delta") {
                  sawDeltaEvent = true;
                  partialText += `${text}\n`;
                  void maybePersistPartialSnapshot();
                  emitDeltaProgressSummary();
                  if (
                    streamedSizeController &&
                    !streamedSizeController.signal.aborted &&
                    partialText.trim().length > (input.maxStreamedChars || 0)
                  ) {
                    streamedSizeExceeded = true;
                    input.emitImplementObservation(
                      "codex",
                      `staged_llm chunk output exceeded ${input.maxStreamedChars} chars before completion; aborting request so it can be subdivided.`,
                      {
                        attempt: input.attempt,
                        threadId: input.threadId,
                        publicDir: input.publicDir
                      }
                    );
                    streamedSizeController.abort();
                  }
                  return;
                }
                input.emitImplementObservation("codex", text, {
                  attempt: input.attempt,
                  threadId: input.threadId,
                  publicDir: input.publicDir
                });
              }
            });
          } finally {
            clearProgressStallTimer();
          }
          break;
        } catch (error) {
          const canRetryTransient =
            !llmAbortSignal?.aborted &&
            isTransientStagedLlmProviderError(error) &&
            requestAttempt < IMPLEMENT_STAGED_LLM_TRANSIENT_RETRY_MAX_ATTEMPTS;
          if (!canRetryTransient) {
            throw error;
          }
          const discardedPartialChars = partialText.trim().length;
          if (discardedPartialChars > 0) {
            await persistPartialSnapshot();
            partialText = "";
            lastDeltaObservationChars = 0;
            lastDeltaObservationAt = 0;
            sawDeltaEvent = false;
          }
          input.emitImplementObservation(
            "codex",
            [
              `Transient staged_llm provider error; retrying request ${requestAttempt + 1}/${IMPLEMENT_STAGED_LLM_TRANSIENT_RETRY_MAX_ATTEMPTS}: ${trimBlock(
                error instanceof Error ? error.message : String(error),
                400
              )}`,
              discardedPartialChars > 0
                ? `Discarded ${discardedPartialChars} chars of incomplete provider output before retrying the same request.`
                : undefined
            ]
              .filter(Boolean)
              .join(" "),
            {
              attempt: input.attempt,
              threadId: input.threadId,
              publicDir: input.publicDir
            }
          );
          await delay(IMPLEMENT_STAGED_LLM_TRANSIENT_RETRY_DELAY_MS * requestAttempt, llmAbortSignal);
        }
      }
      if (!completion) {
        throw new Error("staged_llm provider did not return a completion");
      }
      emitDeltaProgressSummary(true);
      if (completion.text.trim()) {
        partialText = completion.text;
        await persistPartialSnapshot();
      }
      if (input.maxStreamedChars && input.maxStreamedChars > 0 && completion.text.trim().length > input.maxStreamedChars) {
        input.emitImplementObservation(
          "codex",
          `staged_llm chunk completion exceeded ${input.maxStreamedChars} chars; asking materialization to subdivide instead of accepting an oversized chunk.`,
          {
            attempt: input.attempt,
            threadId: input.threadId,
            publicDir: input.publicDir
          }
        );
        throw new Error(
          `implement_experiments staged_llm request exceeded ${input.maxStreamedChars} chars before completion`
        );
      }
      return {
        text: completion.text,
        threadId: completion.threadId
      };
    } catch (error) {
      await persistPartialSnapshot();
      if (progressStallController?.signal.aborted && progressStalled && !input.abortSignal?.aborted) {
        const timeoutMessage = sawDeltaEvent
          ? `staged_llm stall timeout preserved ${partialText.trim().length} chars of partial output in ${formatArtifactPath(partialResponsePath)}.`
          : sawProgressEvent
            ? `staged_llm stalled after provider progress without any text delta; partial snapshot remains empty.`
            : `staged_llm stalled before any provider progress was observed.`;
        input.emitImplementObservation("codex", timeoutMessage, {
          attempt: input.attempt,
          threadId: input.threadId,
          publicDir: input.publicDir
        });
        throw new Error(
          `implement_experiments staged_llm request timed out after ${progressStallTimeoutMs}ms without provider progress`
        );
      }
      if (timeoutController?.signal.aborted && !input.abortSignal?.aborted) {
        const timeoutMessage = sawDeltaEvent
          ? `staged_llm timeout preserved ${partialText.trim().length} chars of partial output in ${formatArtifactPath(partialResponsePath)}.`
          : sawProgressEvent
            ? `staged_llm timed out after provider progress without any text delta; partial snapshot remains empty.`
            : `staged_llm timed out before any provider progress was observed.`;
        input.emitImplementObservation("codex", timeoutMessage, {
          attempt: input.attempt,
          threadId: input.threadId,
          publicDir: input.publicDir
        });
        throw new Error(`implement_experiments staged_llm request timed out after ${input.timeoutMs}ms`);
      }
      if (streamedSizeController?.signal.aborted && streamedSizeExceeded && !input.abortSignal?.aborted) {
        input.emitImplementObservation(
          "codex",
          `staged_llm output-size cap preserved ${partialText.trim().length} chars of partial output in ${formatArtifactPath(partialResponsePath)}.`,
          {
            attempt: input.attempt,
            threadId: input.threadId,
            publicDir: input.publicDir
          }
        );
        throw new Error(
          `implement_experiments staged_llm request exceeded ${input.maxStreamedChars} chars before completion`
        );
      }
      throw error;
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      clearProgressStallTimer();
    }
  }

  private async completeStagedLlmImplementationBundle(input: {
    runDir: string;
    workspaceRoot: string;
    taskSpec: ImplementTaskSpec;
    searchLocalization: LocalizationResult;
    branchPlan: BranchPlan;
    scaffoldPrompt: string;
    systemPrompt: string;
    timeoutMs: number;
    abortSignal?: AbortSignal;
    attempt: number;
    threadId?: string;
    publicDir: string;
    emitImplementObservation: (
      stage: ImplementProgressStage,
      message: string,
      extras?: Partial<ImplementProgressStatus>
    ) => void;
    reasoningEffort?: string;
  }): Promise<{ text: string; threadId?: string }> {
    const loadedStagedResumeManifest = await loadStagedLlmResumeManifest(input.runDir);
    const stagedResumeManifest =
      loadedStagedResumeManifest &&
      isStagedLlmResumeManifestCompatibleWithTaskSpec(loadedStagedResumeManifest, input.taskSpec)
        ? loadedStagedResumeManifest
        : undefined;
    await clearStagedLlmAttemptArtifacts(input.runDir, { preserveResumeArtifacts: Boolean(stagedResumeManifest) });
    if (loadedStagedResumeManifest && !stagedResumeManifest) {
      await fs.rm(path.join(input.runDir, IMPLEMENT_STAGED_LLM_RESUME_MANIFEST_ARTIFACT), { force: true });
      input.emitImplementObservation(
        "codex",
        "Invalidating staged_llm resume artifacts because their experiment-plan fingerprint is stale.",
        {
          attempt: input.attempt,
          threadId: input.threadId,
          publicDir: input.publicDir
        }
      );
    }
    if (stagedResumeManifest) {
      input.emitImplementObservation(
        "codex",
        `Loaded staged_llm resume manifest with ${stagedResumeManifest.completed_sections?.length || 0} completed section(s); matching sections will be reused.`,
        {
          attempt: input.attempt,
          threadId: input.threadId,
          publicDir: input.publicDir
        }
      );
      const nextUnfinishedBoundary = stagedResumeManifest.next_unfinished_section_id || stagedResumeManifest.next_unfinished_artifact;
      if (nextUnfinishedBoundary) {
        const incompleteCount =
          stagedResumeManifest.incomplete_or_failed_artifact_count ??
          stagedResumeManifest.incomplete_or_failed_artifacts?.length ??
          0;
        input.emitImplementObservation(
          "codex",
          `Next staged_llm resume boundary is ${nextUnfinishedBoundary}; ${incompleteCount} incomplete artifact(s) remain.`,
          {
            attempt: input.attempt,
            threadId: input.threadId,
            publicDir: input.publicDir
          }
        );
      }
    }
    if (!shouldDecomposeStagedImplementLlm(this.deps.config)) {
      return this.completeStagedLlmRequest({
        runDir: input.runDir,
        prompt: input.scaffoldPrompt,
        systemPrompt: input.systemPrompt,
        timeoutMs: input.timeoutMs,
        abortSignal: input.abortSignal,
        attempt: input.attempt,
        threadId: input.threadId,
        publicDir: input.publicDir,
        emitImplementObservation: input.emitImplementObservation,
        reasoningEffort: input.reasoningEffort
      });
    }

    const reusableScaffoldParsed = stagedResumeManifest
      ? await readReusableStagedScaffoldArtifact(input.runDir)
      : undefined;
    let scaffoldParsed: ParsedStructuredImplementResponse;
    let activeThreadId = input.threadId;
    if (reusableScaffoldParsed) {
      input.emitImplementObservation(
        "codex",
        "Reusing staged_llm scaffold artifact from the resume manifest boundary.",
        {
          attempt: input.attempt,
          threadId: activeThreadId,
          publicDir: input.publicDir
        }
      );
      scaffoldParsed = reusableScaffoldParsed;
    } else {
      input.emitImplementObservation(
        "codex",
        "Planning staged_llm implementation scaffold before generating file contents.",
        {
          attempt: input.attempt,
          threadId: input.threadId,
          publicDir: input.publicDir
        }
      );
      await ensureDir(path.dirname(path.join(input.runDir, IMPLEMENT_SCAFFOLD_PROMPT_ARTIFACT)));
      await fs.writeFile(path.join(input.runDir, IMPLEMENT_SCAFFOLD_PROMPT_ARTIFACT), input.scaffoldPrompt, "utf8");
      const scaffoldCompletion = await this.completeStagedLlmRequest({
        runDir: input.runDir,
        prompt: input.scaffoldPrompt,
        systemPrompt: appendStagedImplementScaffoldOverrideToPrompt(input.systemPrompt),
        timeoutMs: input.timeoutMs,
        abortSignal: input.abortSignal,
        attempt: input.attempt,
        threadId: input.threadId,
        publicDir: input.publicDir,
        emitImplementObservation: input.emitImplementObservation,
        reasoningEffort: input.reasoningEffort
      });
      await fs.writeFile(
        path.join(input.runDir, IMPLEMENT_SCAFFOLD_RAW_RESPONSE_ARTIFACT),
        scaffoldCompletion.text,
        "utf8"
      );
      scaffoldParsed = parseStructuredResponse(scaffoldCompletion.text);
      activeThreadId = scaffoldCompletion.threadId || input.threadId;
    }
    const cachedBootstrapContract = stagedResumeManifest
      ? await readReusableStagedBootstrapContract(input.runDir)
      : undefined;
    const reusableBootstrapContract =
      cachedBootstrapContract &&
      isReusableBootstrapContractCompatibleWithDependencyRepair(
        cachedBootstrapContract,
        input.taskSpec.context.dependency_repair_context
      )
        ? cachedBootstrapContract
        : undefined;
    if (cachedBootstrapContract && !reusableBootstrapContract) {
      input.emitImplementObservation(
        "codex",
        "Invalidating a staged_llm bootstrap contract whose dependency repair context is stale.",
        {
          attempt: input.attempt,
          threadId: activeThreadId,
          publicDir: input.publicDir
        }
      );
    }
    if (reusableBootstrapContract) {
      input.emitImplementObservation(
        "codex",
        "Reusing staged_llm bootstrap contract artifact from the resume manifest boundary.",
        {
          attempt: input.attempt,
          threadId: activeThreadId,
          publicDir: input.publicDir
        }
      );
    }
    const bootstrapPlanningRequired = shouldRequireExplicitBootstrapPlanning(input.taskSpec, scaffoldParsed.value);
    const bootstrapContractResult = reusableBootstrapContract
      ? {
          contract: reusableBootstrapContract,
          threadId: activeThreadId
        }
      : bootstrapPlanningRequired
        ? await this.completeStagedLlmBootstrapContract({
            runDir: input.runDir,
            taskSpec: input.taskSpec,
            scaffold: scaffoldParsed.value,
            systemPrompt: input.systemPrompt,
            timeoutMs: input.timeoutMs,
            abortSignal: input.abortSignal,
            attempt: input.attempt,
            threadId: activeThreadId,
            publicDir: input.publicDir,
            emitImplementObservation: input.emitImplementObservation,
            reasoningEffort: input.reasoningEffort
          })
        : {
            contract: buildDefaultImplementBootstrapContract(input.taskSpec),
            threadId: activeThreadId
          };
    activeThreadId = bootstrapContractResult.threadId || activeThreadId;
    const bootstrapContract = applyDependencyRepairContextToBootstrapContract(
      bootstrapContractResult.contract,
      input.taskSpec.context.dependency_repair_context
    );
    await writeJsonFile(
      path.join(input.runDir, IMPLEMENT_BOOTSTRAP_CONTRACT_ARTIFACT),
      bootstrapContract
    );
    const bootstrapContractPublicPath = path.join(input.publicDir, "bootstrap_contract.json");
    await ensureDir(path.dirname(bootstrapContractPublicPath));
    await writeJsonFile(bootstrapContractPublicPath, bootstrapContract);
    scaffoldParsed.value.artifacts = dedupeStrings([
      ...(scaffoldParsed.value.artifacts || []),
      path.join(input.runDir, IMPLEMENT_BOOTSTRAP_CONTRACT_ARTIFACT)
    ]);
    scaffoldParsed.value.public_artifacts = dedupeStrings([
      ...(scaffoldParsed.value.public_artifacts || []),
      bootstrapContractPublicPath
    ]);
    const bootstrapEvaluation = await evaluateImplementBootstrapContract({
      contract: bootstrapContract,
      workspaceRoot: input.workspaceRoot
    });
    if (bootstrapEvaluation.status === "block") {
      throw new Error(`bootstrap contract blocked implementation before code generation: ${bootstrapEvaluation.summary}`);
    }
    const scaffoldPlanNormalizationRoots = dedupeStrings([
      input.workspaceRoot,
      path.resolve(input.publicDir, ".."),
      path.resolve(input.publicDir, "..", ".."),
      path.resolve(input.publicDir, "..", "..", "..")
    ]);
    const reusableDecompositionPlan = stagedResumeManifest
      ? await readReusableStagedDecompositionPlan(input.runDir, input.workspaceRoot)
      : undefined;
    if (reusableDecompositionPlan) {
      input.emitImplementObservation(
        "codex",
        "Reusing staged_llm decomposition plan artifact from the resume manifest boundary.",
        {
          attempt: input.attempt,
          threadId: activeThreadId,
          publicDir: input.publicDir
        }
      );
    }
    const normalizedScaffoldDecompositionPlan = reusableDecompositionPlan
      ? undefined
      : normalizeDynamicDecompositionPlanAcrossRoots(
        scaffoldParsed.value.decomposition_plan,
        scaffoldPlanNormalizationRoots
      );
    const synthesizedDecompositionPlan = reusableDecompositionPlan || normalizedScaffoldDecompositionPlan
      ? undefined
      : synthesizeDecompositionPlanFromScaffoldAcrossRoots(scaffoldParsed.value, scaffoldPlanNormalizationRoots);
    if (synthesizedDecompositionPlan) {
      input.emitImplementObservation(
        "codex",
        "Scaffold omitted decomposition_plan; synthesized a local staged_llm decomposition plan from scaffold targets.",
        {
          attempt: input.attempt,
          threadId: activeThreadId,
          publicDir: input.publicDir
        }
      );
    }
    const decompositionPlanRepair =
      reusableDecompositionPlan || normalizedScaffoldDecompositionPlan || synthesizedDecompositionPlan
        ? undefined
        : await this.completeStagedLlmDecompositionPlan({
        runDir: input.runDir,
        workspaceRoot: input.workspaceRoot,
        taskSpec: input.taskSpec,
        searchLocalization: input.searchLocalization,
        branchPlan: input.branchPlan,
        scaffold: scaffoldParsed.value,
        systemPrompt: input.systemPrompt,
        timeoutMs: input.timeoutMs,
        abortSignal: input.abortSignal,
        attempt: input.attempt,
        threadId: activeThreadId,
        publicDir: input.publicDir,
        emitImplementObservation: input.emitImplementObservation,
        reasoningEffort: input.reasoningEffort
      });
    activeThreadId = decompositionPlanRepair?.threadId || activeThreadId;
    const decompositionPlan =
      reusableDecompositionPlan ||
      normalizedScaffoldDecompositionPlan ||
      synthesizedDecompositionPlan ||
      decompositionPlanRepair?.plan;
    if (!decompositionPlan) {
      throw new Error(
        "staged_llm scaffold did not return a parseable decomposition_plan and the decomposition repair turn did not recover one"
      );
    }
    const materializableUnitRepair =
      decompositionPlan.units.some(isMaterializableTextUnit)
        ? undefined
        : await this.completeStagedLlmMaterializableUnitRepair({
            runDir: input.runDir,
            workspaceRoot: input.workspaceRoot,
            taskSpec: input.taskSpec,
            searchLocalization: input.searchLocalization,
            branchPlan: input.branchPlan,
            scaffold: scaffoldParsed.value,
            decompositionPlan,
            systemPrompt: input.systemPrompt,
            timeoutMs: input.timeoutMs,
            abortSignal: input.abortSignal,
            attempt: input.attempt,
            threadId: activeThreadId,
            publicDir: input.publicDir,
            emitImplementObservation: input.emitImplementObservation,
            reasoningEffort: input.reasoningEffort
          });
    activeThreadId = materializableUnitRepair?.threadId || activeThreadId;
    const finalDecompositionPlan = materializableUnitRepair?.plan || decompositionPlan;
    const materializationUnits = finalDecompositionPlan.units.filter(isMaterializableTextUnit);
    if (materializationUnits.length === 0) {
      throw new Error("staged_llm scaffold did not declare any materializable text units");
    }
    await writeJsonFile(path.join(input.runDir, IMPLEMENT_SCAFFOLD_ARTIFACT), scaffoldParsed.value);
    await writeJsonFile(path.join(input.runDir, IMPLEMENT_DECOMPOSITION_PLAN_ARTIFACT), finalDecompositionPlan);
    await writeJsonFile(path.join(input.runDir, IMPLEMENT_FILE_PLAN_ARTIFACT), {
      files: materializationUnits.map((unit) => unit.target_path),
      units: materializationUnits.map((unit) => ({
        id: unit.id,
        unit_type: unit.unit_type,
        title: unit.title,
        purpose: unit.purpose,
        target_path: unit.target_path,
        depends_on: unit.depends_on,
        verification_focus: unit.verification_focus
      }))
    });

    const fileEdits: StructuredImplementFileEdit[] = [];
    for (const [index, unit] of materializationUnits.entries()) {
      const filePath = unit.target_path!;
      const reusableMaterializationPlan = stagedResumeManifest
        ? await readReusableStagedMaterializationPlan(input.runDir, unit.id)
        : undefined;
      if (reusableMaterializationPlan) {
        input.emitImplementObservation(
          "codex",
          `Reusing staged_llm materialization plan artifact for ${unit.id} from the resume manifest boundary.`,
          {
            attempt: input.attempt,
            threadId: activeThreadId,
            publicDir: input.publicDir
          }
        );
      }
      const materializationPlanResult = reusableMaterializationPlan
        ? {
            plan: reusableMaterializationPlan,
            threadId: activeThreadId
          }
        : await this.completeStagedLlmMaterializationPlan({
            runDir: input.runDir,
            taskSpec: input.taskSpec,
            searchLocalization: input.searchLocalization,
            branchPlan: input.branchPlan,
            scaffold: scaffoldParsed.value,
            decompositionPlan: finalDecompositionPlan,
            unit,
            timeoutMs: input.timeoutMs,
            abortSignal: input.abortSignal,
            attempt: input.attempt,
            threadId: activeThreadId,
            publicDir: input.publicDir,
            emitImplementObservation: input.emitImplementObservation,
            reasoningEffort: input.reasoningEffort
          });
      const materializationPlan = materializationPlanResult.plan;
      activeThreadId = materializationPlanResult.threadId || activeThreadId;
      await ensureDir(path.join(input.runDir, IMPLEMENT_UNIT_PLAN_DIR));
      await writeJsonFile(
        path.join(input.runDir, IMPLEMENT_UNIT_PLAN_DIR, `${sanitizeArtifactId(unit.id)}.json`),
        materializationPlan
      );

      const useSectionedSkeleton = shouldUseSectionedSkeletonForTarget(filePath);

      const useDirectFileMaterialization =
        materializationPlan.chunks.length === 1 &&
        !useSectionedSkeleton &&
        !isPythonMaterializationPath(filePath);

      if (useDirectFileMaterialization) {
        input.emitImplementObservation(
          "codex",
          `Generating staged_llm unit ${index + 1}/${materializationUnits.length}: ${unit.title} (${formatArtifactPath(filePath)})`,
          {
            attempt: input.attempt,
            threadId: activeThreadId,
            publicDir: input.publicDir
          }
        );
        const fileCompletion = await this.completeStagedLlmRequest({
          runDir: input.runDir,
          prompt: this.buildStagedImplementFilePrompt({
            taskSpec: input.taskSpec,
            searchLocalization: input.searchLocalization,
            branchPlan: input.branchPlan,
            scaffold: scaffoldParsed.value,
            decompositionPlan: finalDecompositionPlan,
            unit,
            index: index + 1,
            total: materializationUnits.length
          }),
          systemPrompt: appendStagedImplementFileOverrideToPrompt(input.systemPrompt, filePath),
          timeoutMs: input.timeoutMs,
          abortSignal: input.abortSignal,
          attempt: input.attempt,
          threadId: activeThreadId,
          publicDir: input.publicDir,
          emitImplementObservation: input.emitImplementObservation,
          reasoningEffort: input.reasoningEffort
        });
        activeThreadId = fileCompletion.threadId || activeThreadId;
        fileEdits.push(parseStructuredFileEditResponse(fileCompletion.text, input.workspaceRoot, filePath));
        continue;
      }

      const plannedSections: PlannedMaterializationSection[] = [];
      for (const [chunkIndex, chunk] of materializationPlan.chunks.entries()) {
        const proactiveLocalSubdivisionPlan = buildProactiveLocalSubdivisionPlanForChunk(
          materializationPlan,
          chunk
        );
        if (proactiveLocalSubdivisionPlan) {
          const baseId = `${sanitizeArtifactId(unit.id)}__${sanitizeArtifactId(chunk.id)}`;
          await writeJsonFile(
            path.join(input.runDir, IMPLEMENT_UNIT_PLAN_DIR, `${baseId}.json`),
            proactiveLocalSubdivisionPlan
          );
          input.emitImplementObservation(
            "codex",
            `Using local proactive micro-stage subdivision for ${chunk.title} before provider materialization.`,
            {
              attempt: input.attempt,
              threadId: activeThreadId,
              publicDir: input.publicDir
            }
          );
        }
        const chunkSubdivisionPlanResult =
          proactiveLocalSubdivisionPlan
            ? {
                plan: proactiveLocalSubdivisionPlan,
                threadId: activeThreadId
              }
            : shouldRequestDynamicChunkSubdivision(materializationPlan, chunk)
              ? await this.completeStagedLlmChunkSubdivisionPlan({
                  runDir: input.runDir,
                  taskSpec: input.taskSpec,
                  searchLocalization: input.searchLocalization,
                  branchPlan: input.branchPlan,
                  scaffold: scaffoldParsed.value,
                  decompositionPlan: finalDecompositionPlan,
                  unit,
                  materializationPlan,
                  chunk,
                  timeoutMs: input.timeoutMs,
                  abortSignal: input.abortSignal,
                  attempt: input.attempt,
                  threadId: activeThreadId,
                  publicDir: input.publicDir,
                  emitImplementObservation: input.emitImplementObservation,
                  reasoningEffort: input.reasoningEffort
                })
              : undefined;
        activeThreadId = chunkSubdivisionPlanResult?.threadId || activeThreadId;
        const executableChunks =
          chunkSubdivisionPlanResult?.plan?.chunks && chunkSubdivisionPlanResult.plan.chunks.length > 0
            ? chunkSubdivisionPlanResult.plan.chunks
            : [chunk];

        for (const [subchunkIndex, executableChunk] of executableChunks.entries()) {
          const chunkLabel =
            executableChunks.length > 1
              ? `chunk ${chunkIndex + 1}/${materializationPlan.chunks.length} subchunk ${subchunkIndex + 1}/${executableChunks.length}`
              : `chunk ${chunkIndex + 1}/${materializationPlan.chunks.length}`;
          plannedSections.push({
            section: executableChunk,
            parentChunk: executableChunks.length > 1 ? chunk : undefined,
            chunkSubdivisionPlan: executableChunks.length > 1 ? chunkSubdivisionPlanResult?.plan : undefined,
            chunkIndex: chunkIndex + 1,
            chunkTotal: materializationPlan.chunks.length,
            chunkLabel
          });
        }
      }

      if (plannedSections.length === 0) {
        throw new Error(`staged_llm materialization planning produced no executable sections for ${filePath}`);
      }

      let draftContent = "";
      const completedSectionIds: string[] = [];
      const sectionOutputs = new Map<string, string>();
      let currentFileContent = "";
      if (useSectionedSkeleton) {
        const skeleton = buildCanonicalSectionedSkeleton({
          filePath,
          unit,
          materializationPlan,
          sections: plannedSections
        });
        await ensureDir(path.join(input.runDir, IMPLEMENT_UNIT_SKELETON_DIR));
        await fs.writeFile(
          path.join(input.runDir, IMPLEMENT_UNIT_SKELETON_DIR, `${sanitizeArtifactId(unit.id)}.txt`),
          skeleton,
          "utf8"
        );
        await ensureDir(path.dirname(filePath));
        await fs.writeFile(filePath, skeleton, "utf8");
        currentFileContent = skeleton;
      }

      const chunkDraftsByParent = new Map<string, string>();
      for (const [sectionIndex, plannedSection] of plannedSections.entries()) {
        const parentDraftKey = plannedSection.parentChunk?.id;
        const chunkDraftSoFar = parentDraftKey ? chunkDraftsByParent.get(parentDraftKey) || "" : "";
        const validateSectionContent =
          useSectionedSkeleton && isPythonMaterializationPath(filePath)
            ? async (sectionContent: string) => {
                const candidateContent = applySectionContentToCanonicalSkeleton(
                  currentFileContent,
                  plannedSection.section.id,
                  sectionContent,
                  filePath
                );
                const candidatePath = path.join(
                  input.runDir,
                  IMPLEMENT_UNIT_SECTION_DIR,
                  `${sanitizeArtifactId(unit.id)}__${sanitizeArtifactId(plannedSection.section.id)}__candidate.py`
                );
                await ensureDir(path.dirname(candidatePath));
                await fs.writeFile(candidatePath, candidateContent, "utf8");
                const syntaxObs = await this.deps.aci.runTests(
                  `python3 -m py_compile ${JSON.stringify(candidatePath)}`,
                  path.dirname(candidatePath),
                  input.abortSignal
                );
                if (syntaxObs.status === "ok") {
                  const uppercaseIssue = await detectPythonUndefinedUppercaseReferences(candidatePath);
                  if (uppercaseIssue) {
                    return uppercaseIssue;
                  }
                  return detectPythonMissingConcreteConditionWorkerSurface(candidatePath);
                }
                return trimBlock(syntaxObs.stderr || syntaxObs.stdout || "unknown py_compile failure", 800);
              }
            : undefined;
        let resumedSectionContent = useSectionedSkeleton
          ? await readResumableStagedSectionContent(input.runDir, unit.id, plannedSection.section.id, stagedResumeManifest)
          : undefined;
        if (
          resumedSectionContent !== undefined &&
          shouldRegenerateStagedResumeSectionForImplementationFeedback(input.taskSpec, plannedSection.section.id)
        ) {
          input.emitImplementObservation(
            "codex",
            `Discarding staged_llm resume section ${plannedSection.section.id} because implementation feedback requires regenerating execution/metrics handoff sections.`,
            {
              attempt: input.attempt,
              threadId: activeThreadId,
              publicDir: input.publicDir
            }
          );
          resumedSectionContent = undefined;
        }
        if (resumedSectionContent !== undefined && validateSectionContent) {
          const resumeValidationError = await validateSectionContent(resumedSectionContent);
          if (resumeValidationError) {
            const resumeErrorPath = path.join(
              input.runDir,
              IMPLEMENT_UNIT_CHUNK_RESPONSE_DIR,
              `${sanitizeArtifactId(unit.id)}__${sanitizeArtifactId(plannedSection.section.id)}_resume_reuse_error.txt`
            );
            await ensureDir(path.dirname(resumeErrorPath));
            await fs.writeFile(resumeErrorPath, resumeValidationError, "utf8");
            input.emitImplementObservation(
              "codex",
              `Discarding staged_llm resume section ${plannedSection.section.id} because it no longer passes section validation: ${trimBlock(resumeValidationError, 220)}`,
              {
                attempt: input.attempt,
                threadId: activeThreadId,
                publicDir: input.publicDir
              }
            );
            resumedSectionContent = undefined;
          }
        }
        if (resumedSectionContent !== undefined) {
          input.emitImplementObservation(
            "codex",
            `Reusing staged_llm resume section ${plannedSection.section.id} from prior timed-out materialization.`,
            {
              attempt: input.attempt,
              threadId: activeThreadId,
              publicDir: input.publicDir
            }
          );
        }
        const chunkCompletion = resumedSectionContent !== undefined
          ? { content: resumedSectionContent, threadId: activeThreadId }
          : await this.materializeStagedLlmChunkWithDynamicSubdivision({
          runDir: input.runDir,
          workspaceRoot: input.workspaceRoot,
          taskSpec: input.taskSpec,
          searchLocalization: input.searchLocalization,
          branchPlan: input.branchPlan,
          scaffold: scaffoldParsed.value,
          decompositionPlan: finalDecompositionPlan,
          unit,
          materializationPlan,
          chunk: plannedSection.section,
          parentChunk: plannedSection.parentChunk,
          chunkSubdivisionPlan: plannedSection.chunkSubdivisionPlan,
          chunkIndex: plannedSection.chunkIndex,
          chunkTotal: plannedSection.chunkTotal,
          draftSoFar: draftContent,
          chunkDraftSoFar,
          timeoutMs: input.timeoutMs,
          abortSignal: input.abortSignal,
          attempt: input.attempt,
          threadId: activeThreadId,
          publicDir: input.publicDir,
          emitImplementObservation: input.emitImplementObservation,
          reasoningEffort: input.reasoningEffort,
          unitIndex: index + 1,
          unitTotal: materializationUnits.length,
          chunkLabel: plannedSection.chunkLabel,
          subdivisionDepth: 0,
          systemPrompt: input.systemPrompt,
          completedSectionIds,
          currentFileContent,
          allowLocalEntrypointUtility: Boolean(stagedResumeManifest),
          validateContent: validateSectionContent
        });
        activeThreadId = chunkCompletion.threadId || activeThreadId;
        const sectionContent = chunkCompletion.content;
        ensureMaterializedChunkHasSubstance(sectionContent, filePath, plannedSection.section.id);
        completedSectionIds.push(plannedSection.section.id);
        if (parentDraftKey) {
          chunkDraftsByParent.set(parentDraftKey, appendDraftSection(chunkDraftSoFar, sectionContent));
        }

        if (useSectionedSkeleton) {
          sectionOutputs.set(plannedSection.section.id, sectionContent);
          currentFileContent = applySectionContentToCanonicalSkeleton(
            currentFileContent,
            plannedSection.section.id,
            sectionContent,
            filePath
          );
          await ensureDir(path.dirname(filePath));
          await fs.writeFile(filePath, currentFileContent, "utf8");
          await ensureDir(path.join(input.runDir, IMPLEMENT_UNIT_SECTION_DIR));
          await fs.writeFile(
            path.join(
              input.runDir,
              IMPLEMENT_UNIT_SECTION_DIR,
              `${sanitizeArtifactId(unit.id)}__${sanitizeArtifactId(plannedSection.section.id)}.txt`
            ),
            sectionContent,
            "utf8"
          );
          if (isPythonMaterializationPath(filePath)) {
            const syntaxObs = await this.deps.aci.runTests(
              `python3 -m py_compile ${JSON.stringify(filePath)}`,
              path.dirname(filePath),
              input.abortSignal
            );
            if (syntaxObs.status !== "ok") {
              throw new Error(
                `section materialization for ${filePath}:${plannedSection.section.id} introduced a Python syntax error: ${trimBlock(
                  syntaxObs.stderr || syntaxObs.stdout || "unknown py_compile failure",
                  800
                )}`
              );
            }
          }
        } else {
          draftContent =
            draftContent.trim().length > 0
              ? `${draftContent.trimEnd()}\n\n${sectionContent.trimStart()}`
              : sectionContent;
        }
      }
      if (useSectionedSkeleton) {
        draftContent = stripCanonicalSkeletonMarkers(currentFileContent, filePath);
        await ensureDir(path.dirname(filePath));
        await fs.writeFile(filePath, draftContent, "utf8");
      } else {
        await ensureDir(path.dirname(filePath));
        await fs.writeFile(filePath, draftContent, "utf8");
      }
      ensureMaterializedFileHasSubstance(draftContent, filePath);
      fileEdits.push({
        path: filePath,
        content: draftContent
      });
    }

    await ensureDir(path.dirname(bootstrapContractPublicPath));
    await writeJsonFile(bootstrapContractPublicPath, bootstrapContractResult.contract);

    return {
      threadId: activeThreadId,
      text: JSON.stringify({
        ...scaffoldParsed.value,
        file_edits: fileEdits
      })
    };
  }

  private async materializeStagedLlmChunkWithDynamicSubdivision(input: {
    runDir: string;
    workspaceRoot: string;
    taskSpec: ImplementTaskSpec;
    searchLocalization: LocalizationResult;
    branchPlan: BranchPlan;
    scaffold: StructuredImplementResponse;
    decompositionPlan: DynamicDecompositionPlan;
    unit: DynamicDecompositionUnit;
    materializationPlan: DynamicMaterializationPlan;
    chunk: DynamicMaterializationChunk;
    parentChunk?: DynamicMaterializationChunk;
    chunkSubdivisionPlan?: DynamicMaterializationPlan;
    chunkIndex: number;
    chunkTotal: number;
    draftSoFar: string;
    chunkDraftSoFar: string;
    timeoutMs: number;
    abortSignal?: AbortSignal;
    attempt: number;
    threadId?: string;
    publicDir: string;
    emitImplementObservation: (
      stage: ImplementProgressStage,
      message: string,
      extras?: Partial<ImplementProgressStatus>
    ) => void;
    reasoningEffort?: string;
    unitIndex: number;
    unitTotal: number;
    chunkLabel: string;
    subdivisionDepth: number;
    systemPrompt: string;
    completedSectionIds: string[];
    currentFileContent: string;
    allowLocalEntrypointUtility?: boolean;
    validateContent?: (content: string) => Promise<string | undefined>;
  }): Promise<{ content: string; threadId?: string }> {
    const chunkArtifactId = buildMaterializationChunkArtifactId(input);
    const chunkPrompt = this.buildStagedImplementFileChunkPrompt({
      taskSpec: input.taskSpec,
      searchLocalization: input.searchLocalization,
      branchPlan: input.branchPlan,
      scaffold: input.scaffold,
      decompositionPlan: input.decompositionPlan,
      unit: input.unit,
      materializationPlan: input.materializationPlan,
      chunk: input.chunk,
      parentChunk: input.parentChunk,
      chunkSubdivisionPlan: input.chunkSubdivisionPlan,
      chunkIndex: input.chunkIndex,
      chunkTotal: input.chunkTotal,
      draftSoFar: input.draftSoFar,
      chunkDraftSoFar: input.chunkDraftSoFar,
      completedSectionIds: input.completedSectionIds,
      currentFileContent: input.currentFileContent
    });
    const chunkPromptPath = path.join(input.runDir, IMPLEMENT_UNIT_CHUNK_PROMPT_DIR, `${chunkArtifactId}.txt`);
    await ensureDir(path.dirname(chunkPromptPath));
    await fs.writeFile(chunkPromptPath, chunkPrompt, "utf8");
    input.emitImplementObservation(
      "codex",
      `Generating staged_llm unit ${input.unitIndex}/${input.unitTotal} ${input.chunkLabel}: ${input.chunk.title} (${formatArtifactPath(input.unit.target_path || "")})`,
      {
        attempt: input.attempt,
        threadId: input.threadId,
        publicDir: input.publicDir
      }
    );

    try {
      const chunkCompletion = await this.completeStagedLlmRequest({
        runDir: input.runDir,
        prompt: chunkPrompt,
        systemPrompt: appendStagedImplementChunkOverrideToPrompt(
          input.systemPrompt,
          input.unit.target_path || "",
          input.chunk.id
        ),
        timeoutMs: input.timeoutMs,
        abortSignal: input.abortSignal,
        attempt: input.attempt,
        threadId: input.threadId,
        publicDir: input.publicDir,
        emitImplementObservation: input.emitImplementObservation,
        reasoningEffort: input.reasoningEffort,
        maxStreamedChars: IMPLEMENT_STAGED_LLM_CHUNK_MAX_STREAMED_CHARS
      });
      const chunkRawPath = path.join(input.runDir, IMPLEMENT_UNIT_CHUNK_RESPONSE_DIR, `${chunkArtifactId}.txt`);
      await ensureDir(path.dirname(chunkRawPath));
      await fs.writeFile(chunkRawPath, chunkCompletion.text, "utf8");
      const content = normalizeStagedLlmChunkContent(
        parseStructuredChunkResponse(chunkCompletion.text, input.chunk.id),
        input.unit.target_path || ""
      );
      ensureMaterializedChunkHasSubstance(content, input.unit.target_path || "", input.chunk.id);
      let materializedContent = content;
      let validationContent = appendDraftSection(input.chunkDraftSoFar, materializedContent);
      let validationError = await input.validateContent?.(validationContent);
      const missingConstants = extractUndefinedUppercaseConstantNames(validationError);
      if (validationError && missingConstants.length > 0) {
        const repairResult = await this.completeStagedLlmMissingUppercaseConstantsRepair({
          ...input,
          chunkArtifactId,
          content,
          missingConstants,
          validationError
        });
        const repairedContent = appendDraftSection(repairResult.content, content);
        const repairedValidationContent = appendDraftSection(input.chunkDraftSoFar, repairedContent);
        const repairedValidationError = await input.validateContent?.(repairedValidationContent);
        if (!repairedValidationError) {
          materializedContent = repairedContent;
          validationContent = repairedValidationContent;
          validationError = undefined;
        } else {
          validationContent = repairedValidationContent;
          validationError = repairedValidationError;
        }
      }
      if (validationError) {
        throw new Error(
          `staged_llm chunk response for ${input.chunk.id} failed candidate validation: ${validationError}`
        );
      }
      return {
        content: materializedContent,
        threadId: chunkCompletion.threadId || input.threadId
      };
    } catch (error) {
      const chunkErrorPath = path.join(
        input.runDir,
        IMPLEMENT_UNIT_CHUNK_RESPONSE_DIR,
        `${chunkArtifactId}_error.txt`
      );
      await ensureDir(path.dirname(chunkErrorPath));
      await fs.writeFile(chunkErrorPath, error instanceof Error ? error.message : String(error), "utf8");
      const partialSnapshot = await safeRead(path.join(input.runDir, IMPLEMENT_PARTIAL_RESPONSE_ARTIFACT));
      if (partialSnapshot.trim().length > 0) {
        const chunkPartialPath = path.join(
          input.runDir,
          IMPLEMENT_UNIT_CHUNK_RESPONSE_DIR,
          `${chunkArtifactId}_partial_on_error.txt`
        );
        await ensureDir(path.dirname(chunkPartialPath));
        await fs.writeFile(chunkPartialPath, partialSnapshot, "utf8");
      }
      if (
        !isRetryableImplementStagedLlmMaterializationError(error) ||
        input.subdivisionDepth >= MAX_DYNAMIC_CHUNK_SUBDIVISION_DEPTH
      ) {
        throw error;
      }

      const retryReason = isImplementStagedLlmTimeoutError(error)
        ? "timed out"
        : isImplementStagedLlmOutputSizeError(error)
          ? "exceeded the output-size cap"
          : isCandidateValidationStagedLlmError(error)
            ? "failed candidate validation"
            : "was terminated";
      input.emitImplementObservation(
        "codex",
        `Chunk generation ${retryReason} for ${input.chunk.title}; subdividing it into smaller work units.`,
        {
          attempt: input.attempt,
          threadId: input.threadId,
          publicDir: input.publicDir
        }
      );

      const retrySubdivisionPlan = isImplementStagedLlmOutputSizeError(error)
        ? {
            plan: buildLocalChunkSubdivisionPlanForChunk(input.chunk, { forceSmallerSubdivision: true }),
            threadId: input.threadId
          }
        : await this.completeStagedLlmChunkSubdivisionPlan({
            runDir: input.runDir,
            taskSpec: input.taskSpec,
            searchLocalization: input.searchLocalization,
            branchPlan: input.branchPlan,
            scaffold: input.scaffold,
            decompositionPlan: input.decompositionPlan,
            unit: input.unit,
            materializationPlan: input.chunkSubdivisionPlan || input.materializationPlan,
            chunk: input.chunk,
            timeoutMs: input.timeoutMs,
            abortSignal: input.abortSignal,
            attempt: input.attempt,
            threadId: input.threadId,
            publicDir: input.publicDir,
            emitImplementObservation: input.emitImplementObservation,
            reasoningEffort: input.reasoningEffort,
            forceSmallerSubdivision: true,
            previousFailure: trimBlock(error instanceof Error ? error.message : String(error), 1200)
          });
      if (isImplementStagedLlmOutputSizeError(error)) {
        const baseId = `${sanitizeArtifactId(input.unit.id)}__${sanitizeArtifactId(input.chunk.id)}`;
        await writeJsonFile(path.join(input.runDir, IMPLEMENT_UNIT_PLAN_DIR, `${baseId}.json`), retrySubdivisionPlan.plan);
        input.emitImplementObservation(
          "codex",
          `Using local forced subdivision for ${input.chunk.title} after the staged_llm output-size cap was reached.`,
          {
            attempt: input.attempt,
            threadId: input.threadId,
            publicDir: input.publicDir
          }
        );
      }
      const retryChunks = retrySubdivisionPlan.plan.chunks;
      if (retryChunks.length < 2) {
        throw error;
      }

      let activeThreadId = retrySubdivisionPlan.threadId || input.threadId;
      let subdividedDraft = "";
      for (const [retryIndex, retryChunk] of retryChunks.entries()) {
        const retryResult = await this.materializeStagedLlmChunkWithDynamicSubdivision({
          ...input,
          chunk: retryChunk,
          parentChunk: input.chunk,
          chunkSubdivisionPlan: retrySubdivisionPlan.plan,
          draftSoFar: input.draftSoFar,
          chunkDraftSoFar: appendDraftSection(input.chunkDraftSoFar, subdividedDraft),
          threadId: activeThreadId,
          chunkLabel: `${input.chunkLabel} resubchunk ${retryIndex + 1}/${retryChunks.length}`,
          subdivisionDepth: input.subdivisionDepth + 1,
          completedSectionIds: input.completedSectionIds,
          currentFileContent: input.currentFileContent
        });
        activeThreadId = retryResult.threadId || activeThreadId;
        subdividedDraft =
          subdividedDraft.trim().length > 0
            ? `${subdividedDraft.trimEnd()}\n\n${retryResult.content.trimStart()}`
            : retryResult.content;
      }
      const combinedValidationError = await input.validateContent?.(
        appendDraftSection(input.chunkDraftSoFar, subdividedDraft)
      );
      if (combinedValidationError) {
        throw new Error(
          `staged_llm chunk response for ${input.chunk.id} failed candidate validation: ${combinedValidationError}`
        );
      }
      return {
        content: subdividedDraft,
        threadId: activeThreadId
      };
    }
  }

  private async completeStagedLlmMissingUppercaseConstantsRepair(input: {
    runDir: string;
    taskSpec: ImplementTaskSpec;
    searchLocalization: LocalizationResult;
    branchPlan: BranchPlan;
    scaffold: StructuredImplementResponse;
    decompositionPlan: DynamicDecompositionPlan;
    unit: DynamicDecompositionUnit;
    materializationPlan: DynamicMaterializationPlan;
    chunk: DynamicMaterializationChunk;
    parentChunk?: DynamicMaterializationChunk;
    chunkSubdivisionPlan?: DynamicMaterializationPlan;
    chunkIndex: number;
    chunkTotal: number;
    draftSoFar: string;
    chunkDraftSoFar: string;
    timeoutMs: number;
    abortSignal?: AbortSignal;
    attempt: number;
    threadId?: string;
    publicDir: string;
    emitImplementObservation: (
      stage: ImplementProgressStage,
      message: string,
      extras?: Partial<ImplementProgressStatus>
    ) => void;
    reasoningEffort?: string;
    systemPrompt: string;
    completedSectionIds: string[];
    currentFileContent: string;
    chunkLabel: string;
    chunkArtifactId: string;
    content: string;
    missingConstants: string[];
    validationError: string;
  }): Promise<{ content: string; threadId?: string }> {
    const repairPrompt = this.buildStagedImplementMissingUppercaseConstantsRepairPrompt(input);
    const promptPath = path.join(
      input.runDir,
      IMPLEMENT_UNIT_CHUNK_PROMPT_DIR,
      `${input.chunkArtifactId}_constant_repair.txt`
    );
    await ensureDir(path.dirname(promptPath));
    await fs.writeFile(promptPath, repairPrompt, "utf8");
    input.emitImplementObservation(
      "codex",
      `Repairing missing uppercase constants for ${input.chunk.title}: ${input.missingConstants.join(", ")}`,
      {
        attempt: input.attempt,
        threadId: input.threadId,
        publicDir: input.publicDir
      }
    );
    const completion = await this.completeStagedLlmRequest({
      runDir: input.runDir,
      prompt: repairPrompt,
      systemPrompt: appendStagedImplementChunkOverrideToPrompt(
        input.systemPrompt,
        input.unit.target_path || "",
        input.chunk.id
      ),
      timeoutMs: input.timeoutMs,
      abortSignal: input.abortSignal,
      attempt: input.attempt,
      threadId: input.threadId,
      publicDir: input.publicDir,
      emitImplementObservation: input.emitImplementObservation,
      reasoningEffort: input.reasoningEffort
    });
    const rawPath = path.join(
      input.runDir,
      IMPLEMENT_UNIT_CHUNK_RESPONSE_DIR,
      `${input.chunkArtifactId}_constant_repair.txt`
    );
    await ensureDir(path.dirname(rawPath));
    await fs.writeFile(rawPath, completion.text, "utf8");
    const content = normalizeStagedLlmChunkContent(
      parseStructuredChunkResponse(completion.text, input.chunk.id),
      input.unit.target_path || ""
    );
    ensureMaterializedChunkHasSubstance(content, input.unit.target_path || "", `${input.chunk.id}_constant_repair`);
    return {
      content,
      threadId: completion.threadId || input.threadId
    };
  }

  private buildStagedImplementMissingUppercaseConstantsRepairPrompt(params: {
    taskSpec: ImplementTaskSpec;
    searchLocalization: LocalizationResult;
    branchPlan: BranchPlan;
    scaffold: StructuredImplementResponse;
    decompositionPlan: DynamicDecompositionPlan;
    unit: DynamicDecompositionUnit;
    materializationPlan: DynamicMaterializationPlan;
    chunk: DynamicMaterializationChunk;
    parentChunk?: DynamicMaterializationChunk;
    chunkSubdivisionPlan?: DynamicMaterializationPlan;
    chunkIndex: number;
    chunkTotal: number;
    draftSoFar: string;
    chunkDraftSoFar: string;
    completedSectionIds: string[];
    currentFileContent: string;
    content: string;
    missingConstants: string[];
    validationError: string;
  }): string {
    return [
      `Staged implement missing uppercase constant repair for chunk ${params.chunkIndex}/${params.chunkTotal}.`,
      `Target file: ${params.unit.target_path}`,
      `Target chunk: ${params.chunk.id} — ${params.chunk.title}`,
      "Return ONLY one JSON object with keys: chunk_id, content.",
      `Set chunk_id exactly to ${JSON.stringify(params.chunk.id)}.`,
      "Return only Python definitions that must be prepended before the attempted chunk content.",
      "Do not repeat the attempted chunk content. Do not emit markdown fences.",
      "Define every missing uppercase constant listed below before any code can reference it.",
      "Use concrete, bounded values appropriate to the task, current file, and chunk purpose.",
      "If a value should be configurable, define a safe default constant and let later config code override it explicitly.",
      "Do not use globals() guards, placeholder strings, TODOs, or undefined names in the repair content.",
      "The repair content must be syntactically valid Python by itself when inserted into the current section.",
      "",
      "Missing uppercase constants:",
      JSON.stringify(params.missingConstants, null, 2),
      "",
      "Candidate validation failure:",
      params.validationError,
      "",
      "Compact task spec:",
      JSON.stringify(compactTaskSpecForChunkPrompt(params.taskSpec), null, 2),
      "",
      "Branch focus:",
      JSON.stringify(compactBranchPlanForStagedLlmPrompt(params.branchPlan), null, 2),
      "",
      "Localization hints:",
      JSON.stringify(compactLocalizationForStagedLlmPrompt(params.searchLocalization), null, 2),
      "",
      "Approved scaffold summary:",
      JSON.stringify(
        {
          summary: params.scaffold.summary,
          script_path: params.scaffold.script_path,
          metrics_path: params.scaffold.metrics_path
        },
        null,
        2
      ),
      "",
      "Approved decomposition unit:",
      JSON.stringify(compactDecompositionUnitForChunkPrompt(params.unit), null, 2),
      "",
      "Approved materialization chunk plan summary:",
      JSON.stringify(compactMaterializationPlanForChunkPrompt(params.materializationPlan), null, 2),
      "",
      ...(params.chunkDraftSoFar.trim().length > 0
        ? [
            "Parent chunk draft so far:",
            JSON.stringify(compactDraftForChunkPrompt(params.chunkDraftSoFar), null, 2),
            ""
          ]
        : []),
      ...(params.parentChunk
        ? [
            "Parent chunk being decomposed:",
            JSON.stringify(compactMaterializationChunkForChunkPrompt(params.parentChunk), null, 2),
            ""
          ]
        : []),
      ...(params.chunkSubdivisionPlan
        ? [
            "Approved chunk subdivision plan summary:",
            JSON.stringify(compactMaterializationPlanForChunkPrompt(params.chunkSubdivisionPlan), null, 2),
            ""
          ]
        : []),
      "Completed section ids:",
      JSON.stringify(params.completedSectionIds, null, 2),
      "",
      "Requested chunk:",
      JSON.stringify(compactMaterializationChunkForChunkPrompt(params.chunk), null, 2),
      "",
      "Attempted chunk content that failed validation:",
      JSON.stringify(compactDraftForChunkPrompt(params.content), null, 2),
      "",
      "Current file excerpt:",
      JSON.stringify(compactDraftForChunkPrompt(params.currentFileContent), null, 2)
    ].join("\n");
  }

  private buildStagedImplementFilePrompt(params: {
    taskSpec: ImplementTaskSpec;
    searchLocalization: LocalizationResult;
    branchPlan: BranchPlan;
    scaffold: StructuredImplementResponse;
    decompositionPlan: DynamicDecompositionPlan;
    unit: DynamicDecompositionUnit;
    index: number;
    total: number;
  }): string {
    return [
      `Staged implement unit generation ${params.index}/${params.total}.`,
      `Target file: ${params.unit.target_path}`,
      "Return ONLY one JSON object with keys: path, content.",
      "Use UTF-8 text. Do not wrap the file content in markdown fences.",
      "",
      "Focused task spec:",
      JSON.stringify(compactTaskSpecForChunkPrompt(params.taskSpec), null, 2),
      "",
      "Search-backed localization hints:",
      JSON.stringify(compactLocalizationForStagedLlmPrompt(params.searchLocalization), null, 2),
      "",
      "Branch focus:",
      JSON.stringify(compactBranchPlanForStagedLlmPrompt(params.branchPlan), null, 2),
      "",
      "Approved scaffold contract:",
      JSON.stringify(
        {
          summary: params.scaffold.summary,
          experiment_mode: params.scaffold.experiment_mode,
          run_command: params.scaffold.run_command,
          test_command: params.scaffold.test_command,
          working_dir: params.scaffold.working_dir,
          changed_files: params.scaffold.changed_files,
          artifacts: params.scaffold.artifacts,
          public_dir: params.scaffold.public_dir,
          public_artifacts: params.scaffold.public_artifacts,
          script_path: params.scaffold.script_path,
          metrics_path: params.scaffold.metrics_path,
          assumptions: params.scaffold.assumptions,
          file_plan: params.scaffold.file_plan,
          decomposition_plan: params.scaffold.decomposition_plan
        },
        null,
        2
      ),
      "",
      "Approved decomposition plan:",
      JSON.stringify(params.decompositionPlan, null, 2),
      "",
      "Requested decomposition unit:",
      JSON.stringify(params.unit, null, 2),
      "",
      "Generate only the requested target file content needed to satisfy the approved scaffold and decomposition unit."
    ].join("\n");
  }

  private async completeStagedLlmBootstrapContract(input: {
    runDir: string;
    taskSpec: ImplementTaskSpec;
    scaffold: StructuredImplementResponse;
    systemPrompt: string;
    timeoutMs: number;
    abortSignal?: AbortSignal;
    attempt: number;
    threadId?: string;
    publicDir: string;
    emitImplementObservation: (
      stage: ImplementProgressStage,
      message: string,
      extras?: Partial<ImplementProgressStatus>
    ) => void;
    reasoningEffort?: string;
  }): Promise<{ contract: ImplementBootstrapContract; threadId?: string }> {
    input.emitImplementObservation(
      "codex",
      "Planning implementation bootstrap/environment contract before code generation.",
      {
        attempt: input.attempt,
        threadId: input.threadId,
        publicDir: input.publicDir
      }
    );
    const bootstrapPrompt = this.buildStagedImplementBootstrapContractPrompt({
      taskSpec: input.taskSpec,
      scaffold: input.scaffold
    });
    await ensureDir(path.dirname(path.join(input.runDir, IMPLEMENT_BOOTSTRAP_CONTRACT_PROMPT_ARTIFACT)));
    await fs.writeFile(
      path.join(input.runDir, IMPLEMENT_BOOTSTRAP_CONTRACT_PROMPT_ARTIFACT),
      bootstrapPrompt,
      "utf8"
    );
    let completion: { text: string; threadId?: string };
    try {
      completion = await this.completeStagedLlmRequest({
        runDir: input.runDir,
        prompt: bootstrapPrompt,
        systemPrompt: appendStagedImplementBootstrapContractOverrideToPrompt(input.systemPrompt),
        timeoutMs: input.timeoutMs,
        abortSignal: input.abortSignal,
        attempt: input.attempt,
        threadId: input.threadId,
        publicDir: input.publicDir,
        emitImplementObservation: input.emitImplementObservation,
        reasoningEffort: input.reasoningEffort
      });
    } catch (error) {
      if (!isImplementStagedLlmTimeoutError(error) && !isProviderTerminatedStagedLlmError(error)) {
        throw error;
      }
      const reason = isProviderTerminatedStagedLlmError(error) ? "was terminated" : "timed out";
      input.emitImplementObservation(
        "codex",
        `Bootstrap contract planning ${reason}; using the local deterministic bootstrap contract.`,
        {
          attempt: input.attempt,
          threadId: input.threadId,
          publicDir: input.publicDir
        }
      );
      return {
        contract: buildDefaultImplementBootstrapContract(input.taskSpec),
        threadId: input.threadId
      };
    }
    await fs.writeFile(
      path.join(input.runDir, IMPLEMENT_BOOTSTRAP_CONTRACT_RAW_RESPONSE_ARTIFACT),
      completion.text,
      "utf8"
    );
    const contract = parseImplementBootstrapContractFromText(completion.text);
    if (!contract) {
      throw new Error("staged_llm bootstrap planning did not return a parseable bootstrap contract");
    }
    return {
      contract,
      threadId: completion.threadId || input.threadId
    };
  }

  private buildStagedImplementBootstrapContractPrompt(params: {
    taskSpec: ImplementTaskSpec;
    scaffold: StructuredImplementResponse;
  }): string {
    return [
      "Staged implement bootstrap contract planning.",
      "Return only a single bare JSON object with keys: version, strategy, summary, requires_network, requires_warm_cache, blocking_reason, remediation, requirements, checks.",
      "requirements schema: {\"id\": string, \"kind\": \"model\"|\"tokenizer\"|\"dataset\"|\"binary\"|\"library\"|\"reference_data\"|\"service\", \"source\": \"huggingface\"|\"local\"|\"python\"|\"system\"|\"other\", \"required_for\": string[], \"local_path\"?: string, \"availability\"?: \"assumed_local\"|\"download_required\"|\"unknown\", \"summary\"?: string, \"remediation\"?: string}.",
      "checks schema: {\"id\": string, \"check_type\": \"path_exists\"|\"command_available\"|\"python_module_available\", \"target\": string, \"reason\": string}.",
      "When Hugging Face models/tokenizers or remote datasets are needed, list them explicitly in requirements instead of assuming they are present.",
      "Use blocking_reason only for non-network blockers that would still fail even if remote assets can be fetched, such as missing local paths, unavailable binaries, or missing required Python packages.",
      "Do not add local_path requirements or path_exists checks for artifacts the implementation is expected to create in the public experiment directory, including baseline/result manifests, metrics summaries, generated scripts, result tables, or run outputs.",
      "If dependency_repair_context is present, the contract must explicitly choose one path: prewarm the dependency, declare a concrete available substitute, or block as dependency-blocked before code generation.",
      "If no concrete non-network blocker is known, set blocking_reason to an empty string and put network/cache uncertainty in remediation instead.",
      "",
      "Compact task spec:",
      JSON.stringify(compactTaskSpecForBootstrapPrompt(params.taskSpec), null, 2),
      "",
      "Approved scaffold summary:",
      JSON.stringify(compactScaffoldSummaryForBootstrapPrompt(params.scaffold), null, 2)
    ].join("\n");
  }

  private async completeStagedLlmMaterializationPlan(input: {
    runDir: string;
    taskSpec: ImplementTaskSpec;
    searchLocalization: LocalizationResult;
    branchPlan: BranchPlan;
    scaffold: StructuredImplementResponse;
    decompositionPlan: DynamicDecompositionPlan;
    unit: DynamicDecompositionUnit;
    timeoutMs: number;
    abortSignal?: AbortSignal;
    attempt: number;
    threadId?: string;
    publicDir: string;
    emitImplementObservation: (
      stage: ImplementProgressStage,
      message: string,
      extras?: Partial<ImplementProgressStatus>
    ) => void;
    reasoningEffort?: string;
  }): Promise<{ plan: DynamicMaterializationPlan; threadId?: string }> {
    input.emitImplementObservation(
      "codex",
      `Planning dynamic materialization chunks for ${input.unit.title}.`,
      {
        attempt: input.attempt,
        threadId: input.threadId,
        publicDir: input.publicDir
      }
    );
    let completion: { text: string; threadId?: string };
    try {
      completion = await this.completeStagedLlmRequest({
        runDir: input.runDir,
        prompt: this.buildStagedImplementMaterializationPlanPrompt({
          taskSpec: input.taskSpec,
          searchLocalization: input.searchLocalization,
          branchPlan: input.branchPlan,
          scaffold: input.scaffold,
          decompositionPlan: input.decompositionPlan,
          unit: input.unit
        }),
        systemPrompt: appendStagedImplementMaterializationPlanOverrideToPrompt(input.unit.target_path || ""),
        timeoutMs: input.timeoutMs,
        abortSignal: input.abortSignal,
        attempt: input.attempt,
        threadId: input.threadId,
        publicDir: input.publicDir,
        emitImplementObservation: input.emitImplementObservation,
        reasoningEffort: input.reasoningEffort
      });
    } catch (error) {
      if (isImplementStagedLlmTimeoutError(error) || isProviderTerminatedStagedLlmError(error)) {
        const fallbackPlan = buildLocalMaterializationPlanForUnit(input.unit);
        const reason = isProviderTerminatedStagedLlmError(error) ? "was terminated" : "timed out";
        input.emitImplementObservation(
          "codex",
          `Materialization planning ${reason} for ${input.unit.title}; using a local single-chunk materialization plan.`,
          {
            attempt: input.attempt,
            threadId: input.threadId,
            publicDir: input.publicDir
          }
        );
        return {
          plan: fallbackPlan,
          threadId: input.threadId
        };
      }
      throw error;
    }
    const rawPath = path.join(
      input.runDir,
      IMPLEMENT_UNIT_PLAN_DIR,
      `${sanitizeArtifactId(input.unit.id)}_raw_response.txt`
    );
    await ensureDir(path.dirname(rawPath));
    await fs.writeFile(rawPath, completion.text, "utf8");
    const plan = parseDynamicMaterializationPlan(parseJsonObject(completion.text));
    if (!plan) {
      throw new Error(
        `staged_llm materialization planning did not return a parseable dynamic plan for ${input.unit.target_path || input.unit.id}; decomposition_plan materialization repair turn may be required`
      );
    }
    const boundedPlan = boundMaterializationPlanForUnit(input.unit, plan);
    if (boundedPlan !== plan) {
      input.emitImplementObservation(
        "codex",
        `Materialization planning for ${input.unit.title} exceeded the bounded Python runner plan; using a local micro-stage plan.`,
        {
          attempt: input.attempt,
          threadId: completion.threadId || input.threadId,
          publicDir: input.publicDir
        }
      );
    }
    return {
      plan: boundedPlan,
      threadId: completion.threadId || input.threadId
    };
  }

  private buildStagedImplementMaterializationPlanPrompt(params: {
    taskSpec: ImplementTaskSpec;
    searchLocalization: LocalizationResult;
    branchPlan: BranchPlan;
    scaffold: StructuredImplementResponse;
    decompositionPlan: DynamicDecompositionPlan;
    unit: DynamicDecompositionUnit;
  }): string {
    return [
      "Staged implement materialization subplan.",
      "Return only a single bare JSON object with keys: strategy, rationale, chunks.",
      "Each chunk must be a non-overlapping ordered unit of work for the requested file.",
      "Chunk schema: {\"id\": string, \"title\": string, \"purpose\": string, \"content_kind\": \"code_section\"|\"config_block\"|\"documentation_section\"|\"text_section\", \"include_imports\"?: boolean, \"include_entrypoint\"?: boolean, \"depends_on\"?: string[], \"verification_focus\"?: string[]}.",
      "Choose the smallest ordered set of chunks that matches the experiment purpose, target artifact, and verification focus.",
      "Returning one chunk is valid when the unit is already minimal. Returning multiple chunks is valid when that makes the implementation materially clearer or more reliable.",
      "",
      "Compact task spec:",
      JSON.stringify(compactTaskSpecForStagedLlmPrompt(params.taskSpec), null, 2),
      "",
      "Branch focus:",
      JSON.stringify(compactBranchPlanForStagedLlmPrompt(params.branchPlan), null, 2),
      "",
      "Localization hints:",
      JSON.stringify(compactLocalizationForStagedLlmPrompt(params.searchLocalization), null, 2),
      "",
      "Approved scaffold summary:",
      JSON.stringify(
        {
          summary: params.scaffold.summary,
          run_command: params.scaffold.run_command,
          test_command: params.scaffold.test_command,
          script_path: params.scaffold.script_path,
          metrics_path: params.scaffold.metrics_path
        },
        null,
        2
      ),
      "",
      "Approved decomposition unit:",
      JSON.stringify(params.unit, null, 2),
      "",
      "Approved top-level decomposition plan:",
      JSON.stringify(params.decompositionPlan, null, 2)
    ].join("\n");
  }

  private buildStagedImplementFileChunkPrompt(params: {
    taskSpec: ImplementTaskSpec;
    searchLocalization: LocalizationResult;
    branchPlan: BranchPlan;
    scaffold: StructuredImplementResponse;
    decompositionPlan: DynamicDecompositionPlan;
    unit: DynamicDecompositionUnit;
    materializationPlan: DynamicMaterializationPlan;
    chunk: DynamicMaterializationChunk;
    parentChunk?: DynamicMaterializationChunk;
    chunkSubdivisionPlan?: DynamicMaterializationPlan;
    chunkIndex: number;
    chunkTotal: number;
    draftSoFar: string;
    chunkDraftSoFar: string;
    completedSectionIds: string[];
    currentFileContent: string;
  }): string {
    return [
      `Staged implement unit chunk generation ${params.chunkIndex}/${params.chunkTotal}.`,
      `Target file: ${params.unit.target_path}`,
      `Target chunk: ${params.chunk.id} — ${params.chunk.title}`,
      "Return ONLY one JSON object with keys: chunk_id, content.",
      "Return only the requested chunk content. Do not repeat earlier chunks. Do not emit markdown fences.",
      `Target content budget: keep this chunk at or below ${params.parentChunk ? IMPLEMENT_STAGED_LLM_RETRY_CHUNK_TARGET_CHARS : IMPLEMENT_STAGED_LLM_CHUNK_TARGET_CHARS} characters whenever possible.`,
      "If the requested chunk is broad, implement only its named narrow responsibility; do not include adjacent dataset, model, execution, evaluation, reporting, or entrypoint concerns unless they are explicitly the requested chunk.",
      "Assume planning is already complete. Focus only on materializing the requested section for the approved file.",
      "Do not redesign the file. Treat the current file state and completed sections as the canonical skeleton you are filling.",
      "Materialize executable source now. Do not return placeholder scaffolding, section summaries, or purpose restatements.",
      ...(isPythonMaterializationPath(params.unit.target_path || "")
        ? [
            "Because the target is a Python source file, content must include concrete Python statements such as imports, assignments, defs, classes, or executable logic.",
            "Do not return comment-only, TODO-only, or doc-outline-only content."
          ]
        : []),
      "",
      "Compact task spec:",
      JSON.stringify(compactTaskSpecForChunkPrompt(params.taskSpec), null, 2),
      "",
      "Approved scaffold summary:",
      JSON.stringify(
        {
          summary: params.scaffold.summary,
          script_path: params.scaffold.script_path,
          metrics_path: params.scaffold.metrics_path
        },
        null,
        2
      ),
      "",
      "Approved decomposition unit:",
      JSON.stringify(compactDecompositionUnitForChunkPrompt(params.unit), null, 2),
      "",
      "Approved materialization chunk plan summary:",
      JSON.stringify(compactMaterializationPlanForChunkPrompt(params.materializationPlan), null, 2),
      "",
      ...(params.chunkDraftSoFar.trim().length > 0
        ? [
            "Parent chunk draft so far:",
            JSON.stringify(compactDraftForChunkPrompt(params.chunkDraftSoFar), null, 2),
            ""
          ]
        : []),
      ...(params.parentChunk
        ? [
            "Parent chunk being decomposed:",
            JSON.stringify(compactMaterializationChunkForChunkPrompt(params.parentChunk), null, 2),
            ""
          ]
        : []),
      ...(params.chunkSubdivisionPlan
        ? [
            "Approved chunk subdivision plan summary:",
            JSON.stringify(compactMaterializationPlanForChunkPrompt(params.chunkSubdivisionPlan), null, 2),
            ""
          ]
        : []),
      "Completed section ids:",
      JSON.stringify(params.completedSectionIds, null, 2),
      "",
      "Requested chunk:",
      JSON.stringify(compactMaterializationChunkForChunkPrompt(params.chunk), null, 2),
      "",
      "Current file excerpt:",
      JSON.stringify(compactDraftForChunkPrompt(params.currentFileContent), null, 2)
    ].join("\n");
  }

  private async completeStagedLlmChunkSubdivisionPlan(input: {
    runDir: string;
    taskSpec: ImplementTaskSpec;
    searchLocalization: LocalizationResult;
    branchPlan: BranchPlan;
    scaffold: StructuredImplementResponse;
    decompositionPlan: DynamicDecompositionPlan;
    unit: DynamicDecompositionUnit;
    materializationPlan: DynamicMaterializationPlan;
    chunk: DynamicMaterializationChunk;
    timeoutMs: number;
    abortSignal?: AbortSignal;
    attempt: number;
    threadId?: string;
    publicDir: string;
    emitImplementObservation: (
      stage: ImplementProgressStage,
      message: string,
      extras?: Partial<ImplementProgressStatus>
    ) => void;
    reasoningEffort?: string;
    forceSmallerSubdivision?: boolean;
    previousFailure?: string;
  }): Promise<{ plan: DynamicMaterializationPlan; threadId?: string }> {
    input.emitImplementObservation(
      "codex",
      `Planning dynamic subchunks for ${input.chunk.title}.`,
      {
        attempt: input.attempt,
        threadId: input.threadId,
        publicDir: input.publicDir
      }
    );
    let completion: { text: string; threadId?: string };
    try {
      completion = await this.completeStagedLlmRequest({
        runDir: input.runDir,
        prompt: this.buildStagedImplementChunkSubdivisionPlanPrompt({
          taskSpec: input.taskSpec,
          searchLocalization: input.searchLocalization,
          branchPlan: input.branchPlan,
          scaffold: input.scaffold,
          decompositionPlan: input.decompositionPlan,
          unit: input.unit,
          materializationPlan: input.materializationPlan,
          chunk: input.chunk,
          forceSmallerSubdivision: input.forceSmallerSubdivision,
          previousFailure: input.previousFailure
        }),
        systemPrompt: appendStagedImplementMaterializationPlanOverrideToPrompt(input.unit.target_path || ""),
        timeoutMs: input.timeoutMs,
        abortSignal: input.abortSignal,
        attempt: input.attempt,
        threadId: input.threadId,
        publicDir: input.publicDir,
        emitImplementObservation: input.emitImplementObservation,
        reasoningEffort: input.reasoningEffort
      });
    } catch (error) {
      if (isImplementStagedLlmTimeoutError(error) || isProviderTerminatedStagedLlmError(error)) {
        const fallbackPlan = buildLocalChunkSubdivisionPlanForChunk(input.chunk, {
          forceSmallerSubdivision: input.forceSmallerSubdivision === true
        });
        const reason = isProviderTerminatedStagedLlmError(error) ? "was terminated" : "timed out";
        const fallbackPlanShape =
          fallbackPlan.chunks.length === 1
            ? "single-chunk"
            : fallbackPlan.strategy === "local_two_part_subdivision_fallback"
              ? "two-part"
              : "micro-stage";
        input.emitImplementObservation(
          "codex",
          `Chunk subdivision planning ${reason} for ${input.chunk.title}; using a local ${fallbackPlanShape} subdivision plan.`,
          {
            attempt: input.attempt,
            threadId: input.threadId,
            publicDir: input.publicDir
          }
        );
        const baseId = `${sanitizeArtifactId(input.unit.id)}__${sanitizeArtifactId(input.chunk.id)}`;
        await writeJsonFile(path.join(input.runDir, IMPLEMENT_UNIT_PLAN_DIR, `${baseId}.json`), fallbackPlan);
        return {
          plan: fallbackPlan,
          threadId: input.threadId
        };
      }
      throw error;
    }
    const baseId = `${sanitizeArtifactId(input.unit.id)}__${sanitizeArtifactId(input.chunk.id)}`;
    const rawPath = path.join(input.runDir, IMPLEMENT_UNIT_PLAN_DIR, `${baseId}_raw_response.txt`);
    await ensureDir(path.dirname(rawPath));
    await fs.writeFile(rawPath, completion.text, "utf8");
    const plan = parseDynamicMaterializationPlan(parseJsonObject(completion.text));
    if (!plan) {
      throw new Error(
        `staged_llm chunk subdivision planning did not return a parseable dynamic plan for ${input.unit.target_path || input.unit.id}:${input.chunk.id}`
      );
    }
    await writeJsonFile(path.join(input.runDir, IMPLEMENT_UNIT_PLAN_DIR, `${baseId}.json`), plan);
    return {
      plan,
      threadId: completion.threadId || input.threadId
    };
  }

  private buildStagedImplementChunkSubdivisionPlanPrompt(params: {
    taskSpec: ImplementTaskSpec;
    searchLocalization: LocalizationResult;
    branchPlan: BranchPlan;
    scaffold: StructuredImplementResponse;
    decompositionPlan: DynamicDecompositionPlan;
    unit: DynamicDecompositionUnit;
    materializationPlan: DynamicMaterializationPlan;
    chunk: DynamicMaterializationChunk;
    forceSmallerSubdivision?: boolean;
    previousFailure?: string;
  }): string {
    return [
      "Staged implement chunk subdivision plan.",
      "Return only a single bare JSON object with keys: strategy, rationale, chunks.",
      "Subdivide only the requested parent chunk into smaller non-overlapping ordered subchunks.",
      "Chunk schema: {\"id\": string, \"title\": string, \"purpose\": string, \"content_kind\": \"code_section\"|\"config_block\"|\"documentation_section\"|\"text_section\", \"include_imports\"?: boolean, \"include_entrypoint\"?: boolean, \"depends_on\"?: string[], \"verification_focus\"?: string[]}.",
      "Choose the smallest ordered set of subchunks that matches the experiment purpose and verification focus.",
      "Split executable source by function responsibility whenever a parent chunk combines data access, model setup, training/execution, evaluation, or metrics aggregation.",
      `Keep each subchunk narrow enough to materialize near ${IMPLEMENT_STAGED_LLM_CHUNK_TARGET_CHARS} characters or less as one coherent helper group plus any directly associated call sites.`,
      "When a parent chunk combines dataset/corpus loading, tokenization, model setup, execution, raw evidence capture, aggregate metric reporting, or entrypoint behavior, split those concerns into dependency-safe micro-stages.",
      "When a parent chunk combines an execution loop with raw evidence capture or aggregate metric reporting, split it into dependency-safe micro-stages such as preflight/context resolution, ordered run-plan construction, one-condition execution, raw record persistence, aggregate metric computation, and entrypoint wiring.",
      "Prefer more small subchunks over a large catch-all loop chunk; each code_section subchunk should be materializable as a compact helper group, not a full experiment runner.",
      "Returning a single subchunk is valid only when the parent chunk is already one narrow responsibility.",
      ...(params.forceSmallerSubdivision
        ? [
            "The previous attempt to materialize this parent chunk did not complete.",
            "Return a strictly smaller ordered subdivision with at least 2 subchunks.",
            `For retry subdivision, target subchunks around ${IMPLEMENT_STAGED_LLM_RETRY_CHUNK_TARGET_CHARS} characters or less; prefer 4-8 micro-stages over 2 broad parts when the parent includes multiple helpers.`,
            "For retry subdivision after a timeout, provider termination, or output-size cap, avoid repeating the failed responsibility boundary; if the failed parent mentions dataset/corpus loading, tokenization, model setup, execution, raw results, evidence collection, metrics, reporting, or entrypoint behavior, split those concerns into separate subchunks.",
            "Use the failure below to choose dependency-safe subchunk boundaries.",
            "If the failure names undefined uppercase constants, the earliest subchunk must define those constants before any dataclass, config, or helper references them; otherwise replace them with literal values or explicit config lookups in the same subchunk.",
            ...(params.previousFailure ? ["Previous materialization failure:", params.previousFailure] : [])
          ]
        : []),
      "",
      "Compact task spec:",
      JSON.stringify(compactTaskSpecForStagedLlmPrompt(params.taskSpec), null, 2),
      "",
      "Branch focus:",
      JSON.stringify(compactBranchPlanForStagedLlmPrompt(params.branchPlan), null, 2),
      "",
      "Localization hints:",
      JSON.stringify(compactLocalizationForStagedLlmPrompt(params.searchLocalization), null, 2),
      "",
      "Approved scaffold summary:",
      JSON.stringify(
        {
          summary: params.scaffold.summary,
          run_command: params.scaffold.run_command,
          test_command: params.scaffold.test_command,
          script_path: params.scaffold.script_path,
          metrics_path: params.scaffold.metrics_path
        },
        null,
        2
      ),
      "",
      "Approved decomposition unit:",
      JSON.stringify(params.unit, null, 2),
      "",
      "Approved materialization plan:",
      JSON.stringify(params.materializationPlan, null, 2),
      "",
      "Requested parent chunk to subdivide:",
      JSON.stringify(params.chunk, null, 2)
    ].join("\n");
  }

  private async completeStagedLlmDecompositionPlan(input: {
    runDir: string;
    workspaceRoot: string;
    taskSpec: ImplementTaskSpec;
    searchLocalization: LocalizationResult;
    branchPlan: BranchPlan;
    scaffold: StructuredImplementResponse;
    systemPrompt: string;
    timeoutMs: number;
    abortSignal?: AbortSignal;
    attempt: number;
    threadId?: string;
    publicDir: string;
    emitImplementObservation: (
      stage: ImplementProgressStage,
      message: string,
      extras?: Partial<ImplementProgressStatus>
    ) => void;
    reasoningEffort?: string;
  }): Promise<{ plan?: DynamicDecompositionPlan; threadId?: string } | undefined> {
    input.emitImplementObservation(
      "codex",
      "Scaffold omitted decomposition_plan; synthesizing a purpose-aligned staged_llm decomposition plan.",
      {
        attempt: input.attempt,
        threadId: input.threadId,
        publicDir: input.publicDir
      }
    );

    const completion = await this.completeStagedLlmRequest({
      runDir: input.runDir,
      prompt: this.buildStagedImplementDecompositionPlanPrompt({
        taskSpec: input.taskSpec,
        searchLocalization: input.searchLocalization,
        branchPlan: input.branchPlan,
        scaffold: input.scaffold
      }),
      systemPrompt: appendStagedImplementDecompositionOverrideToPrompt(input.systemPrompt),
      timeoutMs: input.timeoutMs,
      abortSignal: input.abortSignal,
      attempt: input.attempt,
      threadId: input.threadId,
      publicDir: input.publicDir,
      emitImplementObservation: input.emitImplementObservation,
      reasoningEffort: input.reasoningEffort
    });
    await ensureDir(path.dirname(path.join(input.runDir, IMPLEMENT_DECOMPOSITION_PLAN_RAW_RESPONSE_ARTIFACT)));
    await fs.writeFile(
      path.join(input.runDir, IMPLEMENT_DECOMPOSITION_PLAN_RAW_RESPONSE_ARTIFACT),
      completion.text,
      "utf8"
    );
    const parsed = parseDynamicDecompositionPlan(parseJsonObject(completion.text));
    if (!parsed) {
      return {
        threadId: completion.threadId || input.threadId
      };
    }
    return {
      plan: normalizeDynamicDecompositionPlan(parsed, input.workspaceRoot),
      threadId: completion.threadId || input.threadId
    };
  }

  private async completeStagedLlmMaterializableUnitRepair(input: {
    runDir: string;
    workspaceRoot: string;
    taskSpec: ImplementTaskSpec;
    searchLocalization: LocalizationResult;
    branchPlan: BranchPlan;
    scaffold: StructuredImplementResponse;
    decompositionPlan: DynamicDecompositionPlan;
    systemPrompt: string;
    timeoutMs: number;
    abortSignal?: AbortSignal;
    attempt: number;
    threadId?: string;
    publicDir: string;
    emitImplementObservation: (
      stage: ImplementProgressStage,
      message: string,
      extras?: Partial<ImplementProgressStatus>
    ) => void;
    reasoningEffort?: string;
  }): Promise<{ plan?: DynamicDecompositionPlan; threadId?: string } | undefined> {
    input.emitImplementObservation(
      "codex",
      "Decomposition plan omitted materializable text units; requesting a narrower staged_llm repair pass.",
      {
        attempt: input.attempt,
        threadId: input.threadId,
        publicDir: input.publicDir
      }
    );

    const completion = await this.completeStagedLlmRequest({
      runDir: input.runDir,
      prompt: this.buildStagedImplementMaterializableUnitRepairPrompt({
        taskSpec: input.taskSpec,
        searchLocalization: input.searchLocalization,
        branchPlan: input.branchPlan,
        scaffold: input.scaffold,
        decompositionPlan: input.decompositionPlan
      }),
      systemPrompt: appendStagedImplementMaterializableUnitRepairOverrideToPrompt(input.systemPrompt),
      timeoutMs: input.timeoutMs,
      abortSignal: input.abortSignal,
      attempt: input.attempt,
      threadId: input.threadId,
      publicDir: input.publicDir,
      emitImplementObservation: input.emitImplementObservation,
      reasoningEffort: input.reasoningEffort
    });
    const repairRawPath = path.join(input.runDir, "implement_experiments", "decomposition_plan_materializable_raw_response.txt");
    await ensureDir(path.dirname(repairRawPath));
    await fs.writeFile(repairRawPath, completion.text, "utf8");
    const parsed = parseDynamicDecompositionPlan(parseJsonObject(completion.text));
    if (!parsed) {
      return {
        threadId: completion.threadId || input.threadId
      };
    }
    return {
      plan: normalizeDynamicDecompositionPlan(parsed, input.workspaceRoot),
      threadId: completion.threadId || input.threadId
    };
  }

  private buildStagedImplementDecompositionPlanPrompt(params: {
    taskSpec: ImplementTaskSpec;
    searchLocalization: LocalizationResult;
    branchPlan: BranchPlan;
    scaffold: StructuredImplementResponse;
  }): string {
    const repairContext = buildCompactImplementDecompositionRepairContext({
      taskSpec: params.taskSpec,
      searchLocalization: params.searchLocalization,
      branchPlan: params.branchPlan,
      scaffold: params.scaffold
    });
    return [
      "Staged implement decomposition planning repair.",
      "Return only a single bare JSON object. Do not use markdown fences. Do not add commentary.",
      "Schema: {\"objective\": string, \"strategy\": string, \"rationale\": string, \"units\": DynamicUnit[]}.",
      "DynamicUnit schema: {\"id\": string, \"unit_type\": \"text_file\"|\"config_file\"|\"documentation_file\"|\"analysis_step\"|\"execution_step\"|\"verification_step\", \"title\": string, \"purpose\": string, \"generation_mode\": \"materialize_text_file\"|\"plan_only\", \"target_path\"?: string, \"depends_on\"?: string[], \"verification_focus\"?: string[]}.",
      "Use generation_mode=materialize_text_file only for text artifacts AutoLabOS must materialize now.",
      "Return only the smallest set of units actually required for this experiment bundle.",
      "Make the decomposition purpose-aligned to this experiment only. Do not invent generic units that the current research goal does not need.",
      "",
      "Example valid shape:",
      JSON.stringify(
        {
          objective: "Materialize a bounded experiment bundle for the selected research goal.",
          strategy: "purpose_adaptive_minimal_bundle",
          rationale: "This experiment needs one runner, one config, and one README.",
          units: [
            {
              id: "runner",
              unit_type: "text_file",
              title: "Primary experiment runner",
              purpose: "Run the main bounded experiment.",
              generation_mode: "materialize_text_file",
              target_path: params.scaffold.script_path || "outputs/example/experiment/run_experiment.py",
              verification_focus: ["run_command", "script_exists"]
            }
          ]
        },
        null,
        2
      ),
      "",
      "Repair context:",
      JSON.stringify(repairContext, null, 2)
    ].join("\n");
  }

  private buildStagedImplementMaterializableUnitRepairPrompt(params: {
    taskSpec: ImplementTaskSpec;
    searchLocalization: LocalizationResult;
    branchPlan: BranchPlan;
    scaffold: StructuredImplementResponse;
    decompositionPlan: DynamicDecompositionPlan;
  }): string {
    const materializableTargets = [
      params.scaffold.script_path,
      ...(params.scaffold.changed_files || []),
      ...(params.scaffold.file_plan || [])
    ].filter((value, index, array): value is string => typeof value === "string" && value.length > 0 && array.indexOf(value) === index);
    return [
      "Staged implement decomposition repair for materializable text units.",
      "Return only a single bare JSON object. Do not use markdown fences. Do not add commentary.",
      "Schema: {\"objective\": string, \"strategy\": string, \"rationale\": string, \"units\": DynamicUnit[]}.",
      "DynamicUnit schema: {\"id\": string, \"unit_type\": \"text_file\"|\"config_file\"|\"documentation_file\"|\"analysis_step\"|\"execution_step\"|\"verification_step\", \"title\": string, \"purpose\": string, \"generation_mode\": \"materialize_text_file\"|\"plan_only\", \"target_path\"?: string, \"depends_on\"?: string[], \"verification_focus\"?: string[]}.",
      "The previous decomposition omitted materializable text units. Repair it.",
      "You MUST return at least one unit with generation_mode=\"materialize_text_file\".",
      "If the scaffold names script_path, changed_files, or file_plan entries, use those paths for the materialized units unless they are clearly wrong.",
      "Return only the smallest set of materializable text units needed for the current experiment bundle.",
      "",
      "Compact task spec:",
      JSON.stringify(compactTaskSpecForStagedLlmPrompt(params.taskSpec), null, 2),
      "",
      "Branch focus:",
      JSON.stringify(compactBranchPlanForStagedLlmPrompt(params.branchPlan), null, 2),
      "",
      "Localization hints:",
      JSON.stringify(compactLocalizationForStagedLlmPrompt(params.searchLocalization), null, 2),
      "",
      "Approved scaffold:",
      JSON.stringify(
        {
          summary: params.scaffold.summary,
          run_command: params.scaffold.run_command,
          test_command: params.scaffold.test_command,
          script_path: params.scaffold.script_path,
          changed_files: params.scaffold.changed_files,
          file_plan: params.scaffold.file_plan,
          public_dir: params.scaffold.public_dir,
          metrics_path: params.scaffold.metrics_path
        },
        null,
        2
      ),
      "",
      "Current decomposition plan that needs repair:",
      JSON.stringify(params.decompositionPlan, null, 2),
      "",
      "Candidate materializable target paths:",
      JSON.stringify(materializableTargets, null, 2)
    ].join("\n");
  }

  private buildLocalizerInput(
    taskSpec: ImplementTaskSpec,
    previousAttempt: AttemptRecord | undefined,
    existingChangedFiles: string[]
  ): {
    workspaceRoot: string;
    goal: string;
    topic: string;
    objectiveMetric: string;
    constraints: string[];
    planExcerpt: string;
    hypothesesExcerpt: string;
    previousSummary?: string;
    previousFailureSummary?: string;
    previousRunCommand?: string;
    previousScript?: string;
    existingChangedFiles?: string[];
  } {
    return {
      workspaceRoot: this.deps.workspaceRoot,
      goal: taskSpec.goal,
      topic: taskSpec.context.topic,
      objectiveMetric: taskSpec.context.objective_metric,
      constraints: taskSpec.constraints,
      planExcerpt: taskSpec.context.plan_excerpt,
      hypothesesExcerpt: taskSpec.context.hypotheses_excerpt,
      previousSummary: taskSpec.context.previous_summary,
      previousFailureSummary: previousAttempt?.verify_report.summary || taskSpec.context.runner_feedback?.summary,
      previousRunCommand: taskSpec.context.previous_run_command,
      previousScript: taskSpec.context.previous_script,
      existingChangedFiles
    };
  }

  private async prepareAttemptResult(params: {
    workspaceRoot: string;
    run: RunRecord;
    runDir: string;
    defaultPublicDir: string;
    metricsPath: string;
    branchPlan: BranchPlan;
    result: { threadId?: string; finalText: string };
    changedFiles: Set<string>;
    artifacts: Set<string>;
    publicArtifacts: Set<string>;
    attemptSnapshot?: ImplementAttemptSnapshot;
    experimentLlmProfile: ReturnType<typeof resolveExperimentLlmProfile>;
  }): Promise<PreparedImplementAttempt> {
    const parsedResponse = parseStructuredResponse(params.result.finalText);
    const parsed = parsedResponse.value;
    const normalizedPublicDir =
      normalizeStoredPath(parsed.public_dir, params.workspaceRoot) || params.defaultPublicDir;
    const normalizedMetricsPath =
      normalizeStoredPath(parsed.metrics_path, params.workspaceRoot) || params.metricsPath;
    let normalizedWorkingDir =
      normalizeStoredPath(parsed.working_dir, params.workspaceRoot) || normalizedPublicDir;
    const originalScriptPath =
      normalizeStoredPath(parsed.script_path, params.workspaceRoot) ||
      (await inferScriptPath(params.runDir, normalizedPublicDir, params.workspaceRoot, parsed.run_command));
    let normalizedScriptPath = originalScriptPath;
    let experimentMode = normalizeExperimentMode(parsed.experiment_mode, parsed.summary);
    const normalizedFileEdits = normalizeStructuredFileEdits(parsed.file_edits, params.workspaceRoot);

    await params.attemptSnapshot?.capturePaths([
      normalizedPublicDir,
      normalizedMetricsPath,
      ...normalizedFileEdits.map((item) => item.path)
    ]);
    await materializeStructuredFileEdits(normalizedFileEdits);
    for (const item of normalizedFileEdits) {
      params.changedFiles.add(item.path);
      params.artifacts.add(item.path);
      if (isSubpath(item.path, normalizedPublicDir)) {
        params.publicArtifacts.add(item.path);
      }
    }

    for (const filePath of parsed.changed_files || []) {
      const normalized = normalizeStoredPath(filePath, params.workspaceRoot);
      if (normalized) {
        params.changedFiles.add(normalized);
        params.artifacts.add(normalized);
      }
    }
    for (const filePath of parsed.artifacts || []) {
      const normalized = normalizeStoredPath(filePath, params.workspaceRoot);
      if (normalized) {
        params.artifacts.add(normalized);
      }
    }
    for (const filePath of parsed.public_artifacts || []) {
      const normalized = normalizeStoredPath(filePath, params.workspaceRoot);
      if (normalized) {
        params.publicArtifacts.add(normalized);
        params.artifacts.add(normalized);
      }
    }
    if (normalizedScriptPath) {
      params.changedFiles.add(normalizedScriptPath);
      params.artifacts.add(normalizedScriptPath);
    }

    let baseSummary =
      parsed.summary?.trim() ||
      `Codex implementation session updated ${Math.max(1, params.changedFiles.size)} file(s).`;
    let runCommand =
      parsed.run_command?.trim() ||
      (normalizedScriptPath ? inferRunCommand(normalizedScriptPath, params.workspaceRoot, params.run.id) : "");
    let testCommand = parsed.test_command?.trim() || deriveFallbackTestCommand(normalizedScriptPath);
    const materialized = await materializeDeclaredArtifacts({
      changedFiles: [...params.changedFiles],
      artifacts: [...params.artifacts],
      explicitPublicArtifacts: [...params.publicArtifacts],
      runDir: params.runDir,
      publicDir: normalizedPublicDir,
      scriptPath: normalizedScriptPath
    });
    replaceSetContents(params.changedFiles, materialized.changedFiles);
    replaceSetContents(params.artifacts, materialized.artifacts);
    replaceSetContents(params.publicArtifacts, materialized.publicArtifacts);
    normalizedScriptPath = materialized.scriptPath;
    if (!runCommand && normalizedScriptPath) {
      runCommand = inferRunCommand(normalizedScriptPath, params.workspaceRoot, params.run.id);
    }
    const hasRunnableArtifact = Boolean(runCommand || normalizedScriptPath);

    const localization =
      normalizeLocalizationResult(parsed.localization, params.workspaceRoot) ||
      emptyLocalizationResult();
    runCommand = rewriteWorkspacePathsToPrimary(
      rewriteCommandScriptPath(runCommand, originalScriptPath, normalizedScriptPath),
      params.workspaceRoot
    );
    testCommand =
      rewriteWorkspacePathsToPrimary(
        rewriteCommandScriptPath(testCommand || "", originalScriptPath, normalizedScriptPath),
        params.workspaceRoot
      ) || undefined;
    testCommand = alignLightweightSyntaxCheckToScriptPath({
      command: testCommand,
      scriptPath: normalizedScriptPath,
      workingDir: normalizedWorkingDir,
      workspaceRoot: params.workspaceRoot
    });
    const verificationCommand = testCommand || deriveFallbackTestCommand(normalizedScriptPath);
    const verificationArtifactCandidates = new Set(
      dedupeStrings([
        ...(normalizedScriptPath ? [normalizedScriptPath] : []),
        ...(verificationCommand
          ? extractWorkspacePathsFromCommand(verificationCommand, normalizedWorkingDir, params.workspaceRoot)
          : [])
      ])
    );
    const missingSupplementalArtifacts = materialized.missingArtifacts.filter(
      (filePath) => !verificationArtifactCandidates.has(filePath)
    );
    const verifyReport = !hasRunnableArtifact
      ? buildMissingArtifactVerifyReport(parsedResponse.isStructured)
      : missingSupplementalArtifacts.length > 0
        ? buildMissingArtifactVerifyReport(parsedResponse.isStructured, {
            missingArtifacts: missingSupplementalArtifacts,
            workspaceRoot: params.workspaceRoot
          })
      : {
          status: "not_run" as const,
          next_action: "handoff_to_run_experiments" as const,
          summary: "Local verification has not run yet."
        };

    return {
      threadId: params.result.threadId,
      branchPlan: params.branchPlan,
      workspaceRoot: params.workspaceRoot,
      rawResponse: params.result.finalText,
      summary: baseSummary,
      runCommand,
      testCommand,
      originalScriptPath,
      scriptPath: normalizedScriptPath,
      metricsPath: normalizedMetricsPath,
      workingDir: normalizedWorkingDir,
      experimentMode,
      publicDir: normalizedPublicDir,
      changedFiles: [...params.changedFiles],
      artifacts: [...params.artifacts],
      publicArtifacts: [...params.publicArtifacts],
      localization,
      assumptions: parsed.assumptions || [],
      requestedGpuCount: parsed.requested_gpu_count,
      verifyReport
    };
  }

  private async saveFailureReflection(args: {
    episodeMemory: EpisodeMemory;
    run: RunRecord;
    taskSpec: ImplementTaskSpec;
    branchPlan: BranchPlan;
    attempt: number;
    verifyReport: VerifyReport;
    prepared: PreparedImplementAttempt;
    searchLocalization: LocalizationResult;
  }): Promise<EpisodeRecord> {
    const lesson = deriveLesson(args.verifyReport.failure_type, args.branchPlan);
    const nextTryInstruction = deriveNextTryInstruction(args.verifyReport, args.branchPlan);
    const reflection = await args.episodeMemory.save({
      run_id: args.run.id,
      node_id: "implement_experiments",
      attempt: args.attempt,
      error_class: args.verifyReport.failure_type || "implementation",
      error_message: args.verifyReport.summary,
      plan_excerpt: trimBlock(
        `${args.taskSpec.goal}\nBranch: ${args.branchPlan.summary}\nRationale: ${args.branchPlan.rationale}`,
        800
      ),
      observations: [
        args.verifyReport.stderr_excerpt || "",
        args.verifyReport.stdout_excerpt || "",
        `Localization: ${formatLocalizationSummary(args.prepared.localization)}`,
        `Search localization: ${formatLocalizationSummary(args.searchLocalization)}`
      ].filter(Boolean),
      lesson,
      next_try_instruction: nextTryInstruction
    });

    this.deps.eventStream.emit({
      type: "REFLECTION_SAVED",
      runId: args.run.id,
      node: "implement_experiments",
      agentRole: "implementer",
      payload: {
        episode_id: reflection.episode_id,
        lesson: reflection.lesson,
        next_try_instruction: reflection.next_try_instruction
      }
    });

    return reflection;
  }

  private async verifyAttempt(
    attempt: PreparedImplementAttempt,
    abortSignal: AbortSignal | undefined,
    runId: string,
    attemptNumber: number,
    onProgress?: (
      text: string,
      extras?: Partial<
        Omit<ImplementProgressStatus, "status" | "stage" | "message" | "startedAt" | "updatedAt" | "progressCount" | "maxAttempts">
      >
    ) => void
  ): Promise<VerifyReport> {
    if (attempt.verifyReport.status === "fail") {
      this.deps.eventStream.emit({
        type: "OBS_RECEIVED",
        runId,
        node: "implement_experiments",
        agentRole: "implementer",
        payload: { text: attempt.verifyReport.summary }
      });
      onProgress?.(attempt.verifyReport.summary, { verifyStatus: "fail" });
      return attempt.verifyReport;
    }

    const command = attempt.testCommand?.trim() || deriveFallbackTestCommand(attempt.scriptPath);
    if (!command) {
      const report: VerifyReport = {
        status: "not_run",
        next_action: "handoff_to_run_experiments",
        summary: "No lightweight local verification command was available."
      };
      onProgress?.(report.summary, { verifyStatus: report.status });
      return report;
    }

    const verificationWorkspaceRoot = await resolveLocalVerificationWorkspaceRoot(this.deps.workspaceRoot);
    const executionCommand = rewriteWorkspacePathsForExecution(command, this.deps.workspaceRoot, verificationWorkspaceRoot);
    const executionCwd =
      rewriteWorkspacePathsForExecution(attempt.workingDir, this.deps.workspaceRoot, verificationWorkspaceRoot) ||
      attempt.workingDir;
    let executionScriptPath = rewriteWorkspacePathsForExecution(
      attempt.scriptPath,
      this.deps.workspaceRoot,
      verificationWorkspaceRoot
    );
    executionScriptPath = (await resolvePythonVerificationScriptPath(executionScriptPath)) || executionScriptPath;

    const pythonVerificationSurfacePaths = await collectPythonVerificationSurfacePaths({
      command: executionCommand,
      cwd: executionCwd,
      workspaceRoot: verificationWorkspaceRoot,
      scriptPath: executionScriptPath
    });
    const unfilledSections = await detectPythonIssueAcrossSurfaces(
      pythonVerificationSurfacePaths,
      detectPythonUnfilledAutolabosSections
    );
    if (unfilledSections) {
      const report: VerifyReport = {
        status: "fail",
        command,
        cwd: attempt.workingDir,
        exit_code: 0,
        failure_type: "implementation",
        next_action: "retry_patch",
        stderr_excerpt: unfilledSections,
        summary: buildVerificationFailureSummary(command, "implementation", unfilledSections)
      };
      this.deps.eventStream.emit({
        type: "TEST_FAILED",
        runId,
        node: "implement_experiments",
        agentRole: "implementer",
        payload: {
          command,
          cwd: attempt.workingDir,
          failure_type: report.failure_type,
          stderr: report.stderr_excerpt || report.summary,
          attempt: attemptNumber
        }
      });
      onProgress?.(report.summary, { verificationCommand: command, verifyStatus: report.status });
      return report;
    }

    const missingArtifacts = await collectMissingVerificationArtifacts({
      command: executionCommand,
      cwd: executionCwd,
      workspaceRoot: verificationWorkspaceRoot,
      scriptPath: executionScriptPath
    });
    if (missingArtifacts.length > 0) {
      const report = buildMissingArtifactVerifyReport(true, {
        command,
        missingArtifacts,
        workspaceRoot: attempt.workspaceRoot
      });
      this.deps.eventStream.emit({
        type: "OBS_RECEIVED",
        runId,
        node: "implement_experiments",
        agentRole: "implementer",
        payload: { text: report.summary }
      });
      onProgress?.(report.summary, { verificationCommand: command, verifyStatus: report.status });
      return report;
    }

    const verificationSurfaceReport = validateVerificationCommandSurface({
      comparisonContract: attempt.comparisonContract,
      verificationCommand: command,
      workingDir: attempt.workingDir,
      scriptPath: attempt.scriptPath,
      metricsPath: attempt.metricsPath,
      runCommand: attempt.runCommand
    });
    if (verificationSurfaceReport.verdict === "block") {
      const report = buildDesignImplementationValidationVerifyReport(verificationSurfaceReport);
      this.deps.eventStream.emit({
        type: "OBS_RECEIVED",
        runId,
        node: "implement_experiments",
        agentRole: "implementer",
        payload: { text: report.summary }
      });
      onProgress?.(report.summary, { verificationCommand: command, verifyStatus: report.status });
      return report;
    }

    onProgress?.("Starting local verification via " + command + ".", { verificationCommand: command });
    this.deps.eventStream.emit({
      type: "TOOL_CALLED",
      runId,
      node: "implement_experiments",
      agentRole: "implementer",
      payload: { command, cwd: attempt.workingDir, source: "local_verification", attempt: attemptNumber }
    });

    const obs = await this.deps.aci.runTests(executionCommand, executionCwd, abortSignal);
    const report = summarizeVerification(command, attempt.workingDir, obs, attempt.localization);
    if (report.status === "fail") {
      this.deps.eventStream.emit({
        type: "TEST_FAILED",
        runId,
        node: "implement_experiments",
        agentRole: "implementer",
        payload: {
          command,
          cwd: attempt.workingDir,
          failure_type: report.failure_type,
          stderr: report.stderr_excerpt || report.summary,
          attempt: attemptNumber
        }
      });
      onProgress?.(report.summary, { verificationCommand: command, verifyStatus: report.status });
      return report;
    }

    const runnerSource = executionScriptPath
      ? await fs.readFile(executionScriptPath, "utf8").catch(() => "")
      : "";
    const executionMetricsPath = rewriteWorkspacePathsForExecution(
      attempt.metricsPath,
      this.deps.workspaceRoot,
      verificationWorkspaceRoot
    );
    const metricsText = executionMetricsPath
      ? await fs.readFile(executionMetricsPath, "utf8").catch(() => "")
      : "";
    const primaryEvidenceIntegrityFailure = detectPrimaryEvidenceIntegrityViolation({
      experimentMode: attempt.experimentMode,
      runnerSource,
      metricsText
    });
    if (primaryEvidenceIntegrityFailure) {
      const blocked: VerifyReport = {
        status: "fail",
        command,
        cwd: attempt.workingDir,
        exit_code: 0,
        failure_type: "implementation",
        next_action: "retry_patch",
        stderr_excerpt: primaryEvidenceIntegrityFailure,
        summary: buildVerificationFailureSummary(command, "implementation", primaryEvidenceIntegrityFailure)
      };
      this.deps.eventStream.emit({
        type: "TEST_FAILED",
        runId,
        node: "implement_experiments",
        agentRole: "implementer",
        payload: {
          command,
          cwd: attempt.workingDir,
          failure_type: blocked.failure_type,
          stderr: blocked.stderr_excerpt || blocked.summary,
          attempt: attemptNumber
        }
      });
      onProgress?.(blocked.summary, { verificationCommand: command, verifyStatus: blocked.status });
      return blocked;
    }
    const budgetGuardFailure = runnerSource
      ? detectLongRunningPythonBudgetGuardFailure({
          source: runnerSource,
          timeoutSec: this.deps.config.experiments.timeout_sec,
          scriptName: path.basename(executionScriptPath || attempt.scriptPath || "experiment.py")
        })
      : undefined;
    if (budgetGuardFailure) {
      const blocked: VerifyReport = {
        status: "fail",
        command,
        cwd: attempt.workingDir,
        exit_code: 0,
        failure_type: "implementation",
        next_action: "retry_patch",
        stderr_excerpt: budgetGuardFailure,
        summary: buildVerificationFailureSummary(command, "implementation", budgetGuardFailure)
      };
      this.deps.eventStream.emit({
        type: "TEST_FAILED",
        runId,
        node: "implement_experiments",
        agentRole: "implementer",
        payload: {
          command,
          cwd: attempt.workingDir,
          failure_type: blocked.failure_type,
          stderr: blocked.stderr_excerpt || blocked.summary,
          attempt: attemptNumber
        }
      });
      onProgress?.(blocked.summary, { verificationCommand: command, verifyStatus: blocked.status });
      return blocked;
    }

    if (attempt.experimentMode === "real_execution" && commandRequestsNonEvidenceRun(attempt.runCommand)) {
      const detail =
        "Real-execution handoff is blocked because run_command requests a dry-run, smoke, simulated, or synthetic fallback execution.";
      const blocked: VerifyReport = {
        status: "fail",
        command: attempt.runCommand,
        cwd: attempt.workingDir,
        exit_code: 0,
        failure_type: "implementation",
        next_action: "retry_patch",
        stderr_excerpt: detail,
        summary: buildVerificationFailureSummary(attempt.runCommand, "implementation", detail)
      };
      this.deps.eventStream.emit({
        type: "TEST_FAILED",
        runId,
        node: "implement_experiments",
        agentRole: "implementer",
        payload: {
          command: attempt.runCommand,
          cwd: attempt.workingDir,
          failure_type: blocked.failure_type,
          stderr: blocked.stderr_excerpt || blocked.summary,
          attempt: attemptNumber
        }
      });
      onProgress?.(blocked.summary, { verificationCommand: attempt.runCommand, verifyStatus: blocked.status });
      return blocked;
    }

    this.deps.eventStream.emit({
      type: "OBS_RECEIVED",
      runId,
      node: "implement_experiments",
      agentRole: "implementer",
      payload: { text: report.summary }
    });
    onProgress?.(report.summary, { verificationCommand: command, verifyStatus: report.status });
    return report;
  }
}

async function writeImplementProgressStatus(runDir: string, status: ImplementProgressStatus): Promise<void> {
  await writeJsonFile(path.join(runDir, IMPLEMENT_PROGRESS_STATUS_ARTIFACT), status);
}

async function appendImplementProgressItem(
  runDir: string,
  item: {
    index: number;
    timestamp: string;
    stage: ImplementProgressStage;
    message: string;
    attempt?: number;
    threadId?: string;
    verifyStatus?: VerifyReport["status"];
  }
): Promise<void> {
  const filePath = normalizeFsPath(path.join(runDir, IMPLEMENT_PROGRESS_LOG_ARTIFACT));
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${JSON.stringify(item)}\n`, "utf8");
}

function createCodexProgressEmitter(onText: (text: string) => void): {
  onEvent: (event: CodexEvent) => void;
  flush: () => void;
} {
  const state = {
    buffer: "",
    lastEmitMs: 0
  };

  const emitBuffer = () => {
    const text = oneLine(state.buffer);
    if (!text) {
      state.buffer = "";
      return;
    }
    onText(text);
    state.buffer = "";
    state.lastEmitMs = Date.now();
  };

  return {
    onEvent(event: CodexEvent) {
      const delta = extractEventDelta(event);
      if (delta) {
        state.buffer += delta;
        const now = Date.now();
        const hasBreak = /[\n\r]/u.test(state.buffer);
        const longEnough = state.buffer.length >= 24;
        if (state.lastEmitMs === 0) {
          state.lastEmitMs = now;
        }
        const stale = now - state.lastEmitMs >= 350;
        if (hasBreak || longEnough || stale) {
          emitBuffer();
        }
        return;
      }

      const type = typeof event.type === "string" ? event.type.toLowerCase() : "";
      if (type.endsWith(".completed") || type === "response.completed" || type === "item.completed") {
        emitBuffer();
      }
    },
    flush() {
      emitBuffer();
    }
  };
}

function extractEventDelta(event: CodexEvent): string {
  if (!event || typeof event !== "object") {
    return "";
  }
  const type = typeof event.type === "string" ? event.type : "";
  if (!type.includes("delta")) {
    return "";
  }

  const direct =
    (typeof event.delta === "string" ? event.delta : "") ||
    (typeof event.text === "string" ? event.text : "") ||
    extractTextFromUnknown((event as Record<string, unknown>).item) ||
    extractTextFromUnknown((event as Record<string, unknown>).content);

  return direct;
}

function extractTextFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => extractTextFromUnknown(item)).join("");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as Record<string, unknown>;
  const direct =
    (typeof record.text === "string" ? record.text : "") ||
    (typeof record.output_text === "string" ? record.output_text : "") ||
    (typeof record.delta === "string" ? record.delta : "");
  if (direct) {
    return direct;
  }

  return extractTextFromUnknown(record.content);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 220);
}

function parseStructuredResponse(text: string): ParsedStructuredImplementResponse {
  const parsed = parseJsonObject(text);
  if (!parsed || typeof parsed !== "object") {
    return {
      value: {},
      isStructured: false
    };
  }
  const record = parsed as Record<string, unknown>;
  return {
    value: {
      summary: asString(record.summary),
      run_command: asString(record.run_command),
      test_command: asString(record.test_command),
      working_dir: asString(record.working_dir),
      experiment_mode: asString(record.experiment_mode),
      changed_files: asStringArray(record.changed_files),
      artifacts: asStringArray(record.artifacts),
      public_dir: asString(record.public_dir),
      public_artifacts: asStringArray(record.public_artifacts),
      script_path: asString(record.script_path),
      metrics_path: asString(record.metrics_path),
      requested_gpu_count: asNonNegativeInteger(record.requested_gpu_count),
      localization: record.localization,
      assumptions: asStringArray(record.assumptions),
      decomposition_plan: parseDynamicDecompositionPlan(record.decomposition_plan),
      file_plan: asStringArray(record.file_plan),
      file_edits: asStructuredFileEdits(record.file_edits)
    },
    isStructured: true
  };
}

function asStructuredFileEdits(value: unknown): StructuredImplementFileEdit[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const edits = value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }
      const record = item as Record<string, unknown>;
      const filePath = asString(record.path);
      const content = asString(record.content);
      if (!filePath || content === undefined) {
        return undefined;
      }
      return { path: filePath, content };
    })
    .filter((item): item is StructuredImplementFileEdit => Boolean(item));
  return edits.length > 0 ? edits : undefined;
}

function normalizeStructuredFileEdits(
  fileEdits: StructuredImplementFileEdit[] | undefined,
  workspaceRoot: string
): StructuredImplementFileEdit[] {
  return (fileEdits || [])
    .map((item) => {
      const normalizedPath = normalizeStoredPath(item.path, workspaceRoot);
      if (!normalizedPath) {
        return undefined;
      }
      return {
        path: normalizedPath,
        content: item.content
      };
    })
    .filter((item): item is StructuredImplementFileEdit => Boolean(item));
}

function parseStructuredChunkResponse(text: string, expectedChunkId: string): string {
  const parsed = parseJsonObject(text);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("staged_llm chunk response did not contain a valid JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const chunkId = typeof record.chunk_id === "string" ? record.chunk_id.trim() : "";
  const content = typeof record.content === "string" ? record.content : "";
  if (chunkId !== expectedChunkId) {
    throw new Error(`staged_llm chunk response returned chunk_id=${chunkId || "<missing>"} but expected ${expectedChunkId}`);
  }
  if (!content.trim()) {
    throw new Error(`staged_llm chunk response for ${expectedChunkId} contained no content`);
  }
  return content;
}

function normalizeStagedLlmChunkContent(content: string, filePath: string): string {
  if (!isPythonMaterializationPath(filePath)) {
    return content;
  }
  const lines = content.split(/\r?\n/u);
  const withoutFutureImports = lines.filter(
    (line) => !/^\s*from\s+__future__\s+import\s+annotations\s*(?:#.*)?$/u.test(line)
  );
  return withoutFutureImports.join("\n");
}

function ensureMaterializedChunkHasSubstance(content: string, filePath: string, chunkId: string): void {
  if (hasSubstantiveMaterializedContent(content, filePath)) {
    return;
  }
  throw new Error(
    `staged_llm chunk response for ${chunkId} on ${filePath} only contained placeholder/comment scaffolding`
  );
}

function ensureMaterializedFileHasSubstance(content: string, filePath: string): void {
  if (hasSubstantiveMaterializedContent(content, filePath)) {
    return;
  }
  throw new Error(`staged_llm materialization for ${filePath} produced no substantive source content`);
}

function hasSubstantiveMaterializedContent(content: string, filePath: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) {
    return false;
  }
  if (!isPythonMaterializationPath(filePath)) {
    return true;
  }
  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => !line.startsWith("#"));
}

async function detectPythonUnfilledAutolabosSections(scriptPath?: string): Promise<string | undefined> {
  if (!scriptPath || path.extname(scriptPath) !== ".py") {
    return undefined;
  }
  let source: string;
  try {
    source = await fs.readFile(scriptPath, "utf8");
  } catch {
    return undefined;
  }
  if (!source.includes("AUTOLABOS SECTION")) {
    return undefined;
  }
  const sectionIds = Array.from(source.matchAll(/^\s*#\s*BEGIN AUTOLABOS SECTION\s+([^\s:]+)/gmu))
    .map((match) => match[1])
    .filter(Boolean);
  const uniqueIds = dedupeStrings(sectionIds);
  const visible = uniqueIds.slice(0, 8).join(", ");
  return [
    "Generated Python runner still contains AUTOLABOS SECTION skeleton markers after staged materialization.",
    "Final experiment scripts must contain executable code, not planning-only section placeholders.",
    visible ? `Unfilled or unstripped section marker(s): ${visible}.` : "Unfilled section markers are present.",
    "Regenerate the affected sections, including the CLI entrypoint and metrics writer, before handoff."
  ].join(" ");
}

export async function resolvePythonVerificationScriptPath(scriptPath?: string): Promise<string | undefined> {
  if (!scriptPath) {
    return undefined;
  }
  if (path.extname(scriptPath) === ".py") {
    return scriptPath;
  }
  if (path.extname(scriptPath) !== ".sh") {
    return undefined;
  }

  let source: string;
  try {
    source = await fs.readFile(scriptPath, "utf8");
  } catch {
    return undefined;
  }

  const wrapperDir = path.dirname(scriptPath);
  const candidates = extractPythonRunnerPathsFromShellWrapper(source, wrapperDir);
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function extractPythonRunnerPathsFromShellWrapper(source: string, wrapperDir: string): string[] {
  const shellVariables = new Map<string, string>([
    ["SCRIPT_DIR", wrapperDir],
    ["PWD", wrapperDir]
  ]);
  const candidates = new Set<string>();

  for (const line of source.split(/\r?\n/u)) {
    const assignment = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.+?)\s*(?:#.*)?$/u);
    if (!assignment) {
      continue;
    }
    const name = assignment[1];
    const value = normalizeShellValue(assignment[2] || "");
    if ((name === "SCRIPT_DIR" || name === "PWD") && /\bBASH_SOURCE\b|\bpwd\b/u.test(value)) {
      continue;
    }
    const expanded = expandShellVariables(value, shellVariables);
    if (expanded) {
      shellVariables.set(name, expanded);
      addPythonRunnerCandidate(candidates, expanded, wrapperDir);
    }
  }

  const tokens = source.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  for (const token of tokens) {
    const normalized = normalizeWorkspacePathToken(token);
    if (!normalized) {
      continue;
    }
    const expanded = expandShellVariables(normalized, shellVariables);
    addPythonRunnerCandidate(candidates, expanded, wrapperDir);
  }

  return [...candidates];
}

function normalizeShellValue(value: string): string {
  return value.trim().replace(/^['"]|['"]$/gu, "");
}

function expandShellVariables(value: string, variables: Map<string, string>): string {
  return value
    .replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*):-((?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|[^}])*)\}/gu,
      (_match, name: string, fallback: string) => variables.get(name) || expandShellVariables(fallback, variables)
    )
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_match, name: string) => variables.get(name) || "")
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/gu, (_match, name: string) => variables.get(name) || "");
}

function addPythonRunnerCandidate(candidates: Set<string>, rawValue: string | null, wrapperDir: string): void {
  if (!rawValue) {
    return;
  }
  const value = normalizeShellValue(rawValue);
  if (!/\.py(?:$|[\s"'\\])/iu.test(value)) {
    return;
  }
  const pathMatch = value.match(/(?:^|[\s"'=])([^\s"']+\.py)(?:$|[\s"'])/iu);
  const candidate = pathMatch?.[1] || value;
  if (!looksLikeWorkspacePath(candidate)) {
    return;
  }
  candidates.add(path.normalize(path.isAbsolute(candidate) ? candidate : path.resolve(wrapperDir, candidate)));
}

function pythonSourceDefinesName(source: string, name: string): boolean {
  const escaped = escapeRegex(name);
  return (
    new RegExp(`\\ndef\\s+${escaped}\\s*\\(`, "u").test(`\n${source}`) ||
    new RegExp(`\\nclass\\s+${escaped}\\b`, "u").test(`\n${source}`) ||
    new RegExp(`\\n${escaped}\\s*=`, "u").test(`\n${source}`)
  );
}

function pythonSourceDefinesOrImportsName(source: string, name: string): boolean {
  const escaped = escapeRegex(name);
  return (
    pythonSourceDefinesName(source, name) ||
    new RegExp(`\\n\\s*from\\s+[\\w.]+\\s+import\\s+[^\\n#]*\\b${escaped}\\b`, "u").test(`\n${source}`) ||
    new RegExp(`\\n\\s*import\\s+${escaped}\\b`, "u").test(`\n${source}`)
  );
}

function pythonSourceDefinesConcreteCallableCandidate(source: string, name: string): boolean {
  if (!pythonSourceDefinesOrImportsName(source, name)) {
    return false;
  }
  const escaped = escapeRegex(name);
  const wrapperHelperLooksFallbackOnly =
    source.includes("_autolabos_single_condition_execution_helper_marker") &&
    source.includes("No generated single-condition execution worker was available after materialization.");
  if (wrapperHelperLooksFallbackOnly && name === "run_single_condition") {
    return false;
  }
  if (new RegExp(`\\n\\s*${escaped}\\s*=\\s*run_single_condition\\b`, "u").test(`\n${source}`)) {
    return false;
  }
  return true;
}

function pythonSourceDefinedTopLevelFunctionNames(source: string): string[] {
  return Array.from(source.matchAll(/^def\s+([A-Za-z_]\w*)\s*\(/gmu))
    .map((match) => match[1])
    .filter((name): name is string => Boolean(name));
}

function pythonSourceDefinesConcreteBridgeCallableCandidate(source: string): boolean {
  const skipTerms = [
    "evaluate",
    "evaluation",
    "metric",
    "metrics",
    "payload",
    "marker",
    "status",
    "kwargs",
    "list",
    "normalize",
    "normalise",
    "build",
    "load",
    "append",
    "aggregate",
    "summary",
    "result",
    "record",
    "schema",
    "spec",
    "state"
  ];

  const explicitHighLevelNames = new Set([
    "run_model_execution",
    "execute_model_execution",
    "orchestrate_model_execution",
    "run_model_execution_stage",
    "execute_model_execution_stage",
    "orchestrate_model_execution_stage"
  ]);

  return pythonSourceDefinedTopLevelFunctionNames(source).some((name) => {
    if (!pythonSourceDefinesConcreteCallableCandidate(source, name)) {
      return false;
    }
    const lowered = name.toLowerCase();
    if (lowered.startsWith("_")) {
      return false;
    }
    if (explicitHighLevelNames.has(lowered)) {
      return true;
    }
    if (
      /^(?:run|execute|orchestrate)_[a-z0-9_]*(?:experiment|study|sweep|condition|workflow|suite|grid|loop|trial|plan|model_execution)[a-z0-9_]*$/iu.test(name)
    ) {
      return true;
    }
    if (!lowered.includes("condition")) {
      return false;
    }
    if (!/(?:run|execute|train)/u.test(lowered)) {
      return false;
    }
    return !skipTerms.some((term) => lowered.includes(term));
  });
}

function isImplementStagedLlmTimeoutError(error: unknown): boolean {
  return error instanceof Error && /implement_experiments staged_llm request timed out after \d+ms/.test(error.message);
}

function isImplementStagedLlmOutputSizeError(error: unknown): boolean {
  return error instanceof Error && /implement_experiments staged_llm request exceeded \d+ chars before completion/.test(error.message);
}

async function loadStagedLlmResumeManifest(runDir: string): Promise<StagedLlmResumeManifest | undefined> {
  const manifestPath = path.join(runDir, IMPLEMENT_STAGED_LLM_RESUME_MANIFEST_ARTIFACT);
  const manifestText = await safeRead(manifestPath);
  if (!manifestText.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(manifestText) as StagedLlmResumeManifest;
    if (parsed.status !== "resumable" || parsed.node !== "implement_experiments") {
      return undefined;
    }
    return {
      ...parsed,
      completed_sections: Array.isArray(parsed.completed_sections) ? parsed.completed_sections : [],
      completed_chunk_responses: Array.isArray(parsed.completed_chunk_responses) ? parsed.completed_chunk_responses : [],
      incomplete_or_failed_artifacts: Array.isArray(parsed.incomplete_or_failed_artifacts)
        ? parsed.incomplete_or_failed_artifacts
        : []
    };
  } catch {
    return undefined;
  }
}

export function isStagedLlmResumeManifestCompatibleWithTaskSpec(
  manifest: StagedLlmResumeManifest,
  taskSpec: ImplementTaskSpec
): boolean {
  const manifestPlanHash = manifest.plan_hash?.trim();
  const currentPlanHash = taskSpec.context.plan_hash?.trim();
  if (manifestPlanHash || currentPlanHash) {
    if (manifestPlanHash && currentPlanHash) {
      return manifestPlanHash === currentPlanHash;
    }
    if (manifestPlanHash) {
      return false;
    }
  }
  return !taskSpec.context.plan_changed;
}

async function readJsonArtifact(runDir: string, artifactPath: string): Promise<unknown | undefined> {
  const text = await safeRead(path.join(runDir, artifactPath));
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function readReusableStagedScaffoldArtifact(runDir: string): Promise<ParsedStructuredImplementResponse | undefined> {
  const parsed = await readJsonArtifact(runDir, IMPLEMENT_SCAFFOLD_ARTIFACT);
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const scaffold = parseStructuredResponse(JSON.stringify(parsed));
  const hasMaterializableTarget = Boolean(
    scaffold.value.script_path ||
    scaffold.value.changed_files?.length ||
    scaffold.value.file_plan?.length ||
    scaffold.value.decomposition_plan?.units?.length
  );
  return scaffold.isStructured && hasMaterializableTarget ? scaffold : undefined;
}

async function readReusableStagedBootstrapContract(runDir: string): Promise<ImplementBootstrapContract | undefined> {
  return parseImplementBootstrapContract(await readJsonArtifact(runDir, IMPLEMENT_BOOTSTRAP_CONTRACT_ARTIFACT));
}

async function readReusableStagedDecompositionPlan(
  runDir: string,
  workspaceRoot: string
): Promise<DynamicDecompositionPlan | undefined> {
  const parsed = parseDynamicDecompositionPlan(await readJsonArtifact(runDir, IMPLEMENT_DECOMPOSITION_PLAN_ARTIFACT));
  return normalizeDynamicDecompositionPlan(parsed, workspaceRoot);
}

async function readReusableStagedMaterializationPlan(
  runDir: string,
  unitId: string
): Promise<DynamicMaterializationPlan | undefined> {
  return parseDynamicMaterializationPlan(
    await readJsonArtifact(
      runDir,
      path.join(IMPLEMENT_UNIT_PLAN_DIR, `${sanitizeArtifactId(unitId)}.json`)
    )
  );
}

async function readResumableStagedSectionContent(
  runDir: string,
  unitId: string,
  sectionId: string,
  manifest?: StagedLlmResumeManifest
): Promise<string | undefined> {
  if (!manifest || manifest.status !== "resumable") {
    return undefined;
  }
  const relativeSectionPath = path.join(
    IMPLEMENT_UNIT_SECTION_DIR.replace(/^implement_experiments[\/]/u, ""),
    `${sanitizeArtifactId(unitId)}__${sanitizeArtifactId(sectionId)}.txt`
  );
  const normalizedManifestPaths = new Set((manifest.completed_sections || []).map((item) => item.replace(/\\/g, "/")));
  if (!normalizedManifestPaths.has(relativeSectionPath.replace(/\\/g, "/"))) {
    return undefined;
  }
  const sectionPath = path.join(runDir, "implement_experiments", relativeSectionPath);
  const content = await safeRead(sectionPath);
  return content.trim().length > 0 ? content : undefined;
}

export function shouldRegenerateStagedResumeSectionForImplementationFeedback(
  taskSpec: ImplementTaskSpec,
  sectionId: string
): boolean {
  const implementationFeedback = taskSpec.context.implementation_contract_feedback;
  const runnerFeedback = taskSpec.context.runner_feedback;
  if (
    (!implementationFeedback || implementationFeedback.status !== "fail") &&
    (!runnerFeedback || runnerFeedback.status !== "fail")
  ) {
    return false;
  }
  const text = [
    implementationFeedback?.summary,
    implementationFeedback?.stderr_excerpt,
    implementationFeedback?.suggested_next_action,
    ...(implementationFeedback?.blocking_findings.flatMap((finding) => [
      finding.code,
      finding.message,
      finding.evidence || ""
    ]) || []),
    runnerFeedback?.summary,
    runnerFeedback?.stderr_excerpt,
    runnerFeedback?.stdout_excerpt,
    runnerFeedback?.suggested_next_action,
    runnerFeedback?.failure_code,
    runnerFeedback?.upstream_repair_hint
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  const isBudgetPartialSuccessFeedback =
    /budget-limited partial execution/iu.test(text) ||
    /BUDGET_TIMEOUT_PARTIAL_SUCCESS_HANDOFF/u.test(text) ||
    (/completed_model_execution/iu.test(text) && /\b(?:timeout|budget|coverage)\b/iu.test(text));
  const isUndefinedRuntimeHelperFeedback =
    /critical runtime helper|Undefined helper call/iu.test(text) ||
    /NameError\(["\x27]?name ["\x27][A-Za-z_]\w*["\x27] is not defined["\x27]?\)/u.test(text) ||
    /name ["\x27][A-Za-z_]\w*["\x27] is not defined/iu.test(text) ||
    /missing \d+ required positional argument[s]?: ["\x27](?:runtime|runtime_config|config|args|context|run_context)["\x27]/iu.test(text) ||
    /dependency_preflight_failed/iu.test(text) ||
    /Experiment data bundle could not be materialized:[\s\S]{0,240}\b[A-Z][A-Za-z_]*Error\(\) takes no keyword arguments/iu.test(text) ||
    /\b[A-Z][A-Za-z_]*Error\(\) takes no keyword arguments/iu.test(text);
  const isObjectiveMetricOrNoEvidenceFeedback =
    /Objective metric ["\x27][A-Za-z_][A-Za-z0-9_.-]*["\x27] was not found in metrics\.json/iu.test(text) ||
    /no usable normalized training texts/iu.test(text) ||
    (/completed_model_execution/iu.test(text) && /\b(?:objective|metric|evaluation|missing|not found|no usable)\b/iu.test(text)) ||
    (/\b(?:objective-ready|objective ready|objective metric|configured objective metric)\b/iu.test(text) &&
      /\b(?:missing|not found|not matched|no usable|failed|repair)\b/iu.test(text));
  const isConditionExecutionMissingHelperFeedback =
    /model_execution_failed/iu.test(text) ||
    /no condition execution helper is defined/iu.test(text) ||
    /no condition runner (?:was )?(?:found|defined)/iu.test(text) ||
    /No executable study helper was found/iu.test(text);
  if (
    !isBudgetPartialSuccessFeedback &&
    !isUndefinedRuntimeHelperFeedback &&
    !isObjectiveMetricOrNoEvidenceFeedback &&
    !isConditionExecutionMissingHelperFeedback
  ) {
    return false;
  }
  return /(?:model_execution|condition_execution|run_plan|one_run|raw_records|aggregation|wiring|evaluation|metrics?|entrypoint|handoff|data|dataset|task|loader|load|train(?:ing)?|preprocess|normaliz|samples?|examples?)/iu.test(
    sectionId
  );
}

async function clearStagedLlmAttemptArtifacts(
  runDir: string,
  options: { preserveResumeArtifacts?: boolean } = {}
): Promise<void> {
  const preservedResumeTargets = new Set(
    options.preserveResumeArtifacts
      ? [
          IMPLEMENT_STAGED_LLM_RESUME_MANIFEST_ARTIFACT,
          IMPLEMENT_SCAFFOLD_ARTIFACT,
          IMPLEMENT_DECOMPOSITION_PLAN_ARTIFACT,
          IMPLEMENT_BOOTSTRAP_CONTRACT_ARTIFACT,
          IMPLEMENT_FILE_PLAN_ARTIFACT,
          IMPLEMENT_UNIT_PLAN_DIR,
          IMPLEMENT_UNIT_SECTION_DIR,
          IMPLEMENT_UNIT_SKELETON_DIR,
          IMPLEMENT_UNIT_CHUNK_PROMPT_DIR,
          IMPLEMENT_UNIT_CHUNK_RESPONSE_DIR
        ]
      : [IMPLEMENT_STAGED_LLM_RESUME_MANIFEST_ARTIFACT]
  );
  const targets = [
    IMPLEMENT_PARTIAL_RESPONSE_ARTIFACT,
    IMPLEMENT_SCAFFOLD_ARTIFACT,
    IMPLEMENT_SCAFFOLD_PROMPT_ARTIFACT,
    IMPLEMENT_SCAFFOLD_RAW_RESPONSE_ARTIFACT,
    IMPLEMENT_DECOMPOSITION_PLAN_ARTIFACT,
    IMPLEMENT_DECOMPOSITION_PLAN_RAW_RESPONSE_ARTIFACT,
    IMPLEMENT_BOOTSTRAP_CONTRACT_ARTIFACT,
    IMPLEMENT_BOOTSTRAP_CONTRACT_PROMPT_ARTIFACT,
    IMPLEMENT_BOOTSTRAP_CONTRACT_RAW_RESPONSE_ARTIFACT,
    IMPLEMENT_FILE_PLAN_ARTIFACT,
    IMPLEMENT_UNIT_PLAN_DIR,
    IMPLEMENT_UNIT_SECTION_DIR,
    IMPLEMENT_UNIT_SKELETON_DIR,
    IMPLEMENT_UNIT_CHUNK_PROMPT_DIR,
    IMPLEMENT_UNIT_CHUNK_RESPONSE_DIR
  ].filter((target) => !preservedResumeTargets.has(target));
  await Promise.all(
    targets.map(async (target) => {
      try {
        await fs.rm(path.join(runDir, target), { force: true, recursive: true });
      } catch {
        // Best effort cleanup only; stale diagnostics should not block a new staged attempt.
      }
    })
  );
}

function isRetryableImplementStagedLlmMaterializationError(error: unknown): boolean {
  return (
    isImplementStagedLlmTimeoutError(error) ||
    isImplementStagedLlmOutputSizeError(error) ||
    isProviderTerminatedStagedLlmError(error) ||
    isMalformedJsonStagedLlmChunkError(error) ||
    isCandidateValidationStagedLlmError(error)
  );
}

export function isMalformedJsonStagedLlmChunkError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (
      error.message === "staged_llm chunk response did not contain a valid JSON object" ||
      /staged_llm chunk response returned chunk_id=.+ but expected/u.test(error.message) ||
      /staged_llm chunk response for .+ contained no content/u.test(error.message)
    )
  );
}

function isCandidateValidationStagedLlmError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /staged_llm chunk response for .+ failed candidate validation:/u.test(error.message)
  );
}

function extractUndefinedUppercaseConstantNames(validationError?: string): string[] {
  if (!validationError || !validationError.includes("uppercase constant")) {
    return [];
  }

  const names: string[] = [];
  for (const match of validationError.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b(?=\s+at\s+)/gu)) {
    if (!names.includes(match[1])) {
      names.push(match[1]);
    }
  }
  return names;
}

export function isProviderTerminatedStagedLlmError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.trim().toLowerCase();
  return (
    message === "terminated" ||
    message === "this operation was aborted" ||
    message === "codex oauth stream aborted" ||
    message === "codex oauth backend returned an error: terminated" ||
    message === "codex oauth backend returned an error: this operation was aborted" ||
    message === "codex oauth backend returned an error: codex oauth stream aborted"
  );
}

export function isTransientStagedLlmProviderError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    /\b(?:502|503|504|520|521|522|523|524)\b/u.test(message) ||
    message.includes("our servers are currently overloaded") ||
    message.includes("please try again later") ||
    message.includes("you can retry your request") ||
    message.includes("an error occurred while processing your request") ||
    message.includes("upstream connect error") ||
    message.includes("disconnect/reset before headers") ||
    message.includes("connection termination") ||
    message.includes("failed before receiving an http response") ||
    message.includes("econnreset") ||
    message.includes("socket hang up") ||
    message.includes("codex oauth stream aborted")
  );
}

async function delay(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeDynamicDecompositionPlan(
  plan: DynamicDecompositionPlan | undefined,
  workspaceRoot: string
): DynamicDecompositionPlan | undefined {
  if (!plan) {
    return undefined;
  }
  const normalizedUnits = plan.units
    .map((unit) => {
      const normalizedTargetPath = normalizeStoredPath(unit.target_path, workspaceRoot);
      if (unit.generation_mode === "materialize_text_file" && (!normalizedTargetPath || !isMaterializableImplementTextPath(normalizedTargetPath))) {
        return undefined;
      }
      const normalizedUnit: DynamicDecompositionUnit = {
        ...unit,
        target_path: normalizedTargetPath || unit.target_path
      };
      return normalizedUnit;
    })
    .filter((unit): unit is DynamicDecompositionUnit => unit !== undefined);
  if (normalizedUnits.length === 0) {
    return undefined;
  }
  return {
    ...plan,
    units: normalizedUnits
  };
}


function normalizeDynamicDecompositionPlanAcrossRoots(
  plan: DynamicDecompositionPlan | undefined,
  workspaceRoots: string[]
): DynamicDecompositionPlan | undefined {
  for (const workspaceRoot of workspaceRoots) {
    const normalized = normalizeDynamicDecompositionPlan(plan, workspaceRoot);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function synthesizeDecompositionPlanFromScaffoldAcrossRoots(
  scaffold: StructuredImplementResponse,
  workspaceRoots: string[]
): DynamicDecompositionPlan | undefined {
  for (const workspaceRoot of workspaceRoots) {
    const synthesized = synthesizeDecompositionPlanFromScaffold(scaffold, workspaceRoot);
    if (synthesized) {
      return synthesized;
    }
  }
  return undefined;
}

function synthesizeDecompositionPlanFromScaffold(
  scaffold: StructuredImplementResponse,
  workspaceRoot: string
): DynamicDecompositionPlan | undefined {
  const targets = collectMaterializableScaffoldTargets(scaffold, workspaceRoot);
  if (targets.length === 0) {
    return undefined;
  }

  return buildDynamicDecompositionPlan({
    objective: "Materialize the runnable implementation artifacts named by the scaffold.",
    strategy: "scaffold_target_local_synthesis",
    rationale:
      "The scaffold already identified concrete text artifacts, so AutoLabOS can avoid an extra provider planning turn and preserve progress under bounded staged implementation.",
    units: targets.map((targetPath, index) => ({
      id: `artifact_${index + 1}`,
      unit_type: inferDecompositionUnitTypeForPath(targetPath),
      title: index === 0 ? "Primary scaffold artifact" : `Scaffold artifact ${index + 1}`,
      purpose:
        index === 0
          ? "Materialize the primary runnable artifact declared by the scaffold."
          : "Materialize an additional text artifact declared by the scaffold.",
      generation_mode: "materialize_text_file",
      target_path: targetPath,
      depends_on: index === 0 ? undefined : ["artifact_1"],
      verification_focus: index === 0 ? ["run_command", "test_command"] : ["artifact_materialized"]
    }))
  });
}

function collectMaterializableScaffoldTargets(scaffold: StructuredImplementResponse, workspaceRoot: string): string[] {
  const candidates = [
    scaffold.script_path,
    ...(scaffold.changed_files || []),
    ...(scaffold.file_plan || [])
  ];
  const targets: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.trim().length === 0) {
      continue;
    }
    const normalized = normalizeStoredPath(candidate, workspaceRoot) || candidate.trim();
    if (!isMaterializableImplementTextPath(normalized) || targets.includes(normalized)) {
      continue;
    }
    targets.push(normalized);
  }
  return targets;
}

function inferDecompositionUnitTypeForPath(filePath: string): DynamicDecompositionUnit["unit_type"] {
  const ext = path.extname(filePath).toLowerCase();
  if ([".json", ".yaml", ".yml", ".toml", ".ini", ".cfg"].includes(ext)) {
    return "config_file";
  }
  if (ext === ".md") {
    return "documentation_file";
  }
  return "text_file";
}

function parseDynamicMaterializationPlan(value: unknown): DynamicMaterializationPlan | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const chunks = Array.isArray(record.chunks)
    ? record.chunks
        .map((item) => parseDynamicMaterializationChunk(item))
        .filter((item): item is DynamicMaterializationChunk => Boolean(item))
    : [];
  if (chunks.length === 0) {
    return undefined;
  }
  return {
    strategy:
      typeof record.strategy === "string" && record.strategy.trim().length > 0
        ? record.strategy.trim()
        : "provider_generated_dynamic_plan",
    rationale:
      typeof record.rationale === "string" && record.rationale.trim().length > 0
        ? record.rationale.trim()
        : "The provider returned a dynamic plan without explicit rationale metadata.",
    chunks
  };
}

export function buildLocalMaterializationPlanForUnit(
  unit: DynamicDecompositionUnit
): DynamicMaterializationPlan {
  const contentKind = inferMaterializationChunkKindForPath(unit.target_path || "", unit.unit_type);
  return {
    strategy: "local_single_chunk_fallback",
    rationale:
      "The provider did not return a bounded materialization plan, so the approved decomposition unit remains one provider-authored chunk.",
    chunks: [
      {
        id: "complete_artifact",
        title: "Complete artifact",
        purpose: unit.purpose || "Materialize the approved artifact without introducing domain assumptions.",
        content_kind: contentKind,
        include_imports: contentKind === "code_section",
        include_entrypoint: contentKind === "code_section",
        verification_focus: unit.verification_focus
      }
    ]
  };
}

function boundMaterializationPlanForUnit(
  unit: DynamicDecompositionUnit,
  plan: DynamicMaterializationPlan
): DynamicMaterializationPlan {
  if (plan.chunks.length <= MAX_PROVIDER_PYTHON_RUNNER_CHUNKS) {
    return plan;
  }
  return buildLocalMaterializationPlanForUnit(unit);
}

function shouldRequestDynamicChunkSubdivision(
  materializationPlan: DynamicMaterializationPlan,
  _chunk: DynamicMaterializationChunk
): boolean {
  return materializationPlan.chunks.length > 1 && !(materializationPlan.strategy ?? "").startsWith("local_");
}

function buildProactiveLocalSubdivisionPlanForChunk(
  _materializationPlan: DynamicMaterializationPlan,
  _chunk: DynamicMaterializationChunk
): DynamicMaterializationPlan | undefined {
  return undefined;
}

export function buildLocalChunkSubdivisionPlanForChunk(
  chunk: DynamicMaterializationChunk,
  options: { forceSmallerSubdivision?: boolean } = {}
): DynamicMaterializationPlan {
  if (options.forceSmallerSubdivision || chunk.purpose.length > 600) {
    return buildLocalTwoPartSubdivisionPlanForChunk(chunk);
  }
  return {
    strategy: "local_single_chunk_subdivision_fallback",
    rationale: "The provider did not return a smaller plan, so the existing provider-authored chunk remains intact.",
    chunks: [{ ...chunk }]
  };
}

function buildLocalTwoPartSubdivisionPlanForChunk(chunk: DynamicMaterializationChunk): DynamicMaterializationPlan {
  const firstChunk: DynamicMaterializationChunk = {
    ...chunk,
    id: chunk.id + "_part_1",
    title: chunk.title + " part 1",
    purpose: chunk.purpose + " Cover the first bounded portion of this parent chunk.",
    include_entrypoint: false
  };
  const secondChunk: DynamicMaterializationChunk = {
    ...chunk,
    id: chunk.id + "_part_2",
    title: chunk.title + " part 2",
    purpose: chunk.purpose + " Cover the second bounded portion of this parent chunk and finish the parent contract.",
    include_imports: false,
    include_entrypoint: chunk.include_entrypoint,
    depends_on: [firstChunk.id]
  };
  return {
    strategy: "local_two_part_subdivision_fallback",
    rationale:
      "The provider did not return a forced-smaller subdivision subplan within the bounded request, so AutoLabOS splits the parent chunk into two ordered local parts.",
    chunks: [firstChunk, secondChunk]
  };
}

function inferMaterializationChunkKindForPath(
  filePath: string,
  unitType?: DynamicDecompositionUnit["unit_type"]
): DynamicMaterializationChunk["content_kind"] {
  const ext = path.extname(filePath).toLowerCase();
  if ([".json", ".yaml", ".yml", ".toml", ".ini", ".cfg"].includes(ext) || unitType === "config_file") {
    return "config_block";
  }
  if (ext === ".md" || unitType === "documentation_file") {
    return "documentation_section";
  }
  if ([".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".sh"].includes(ext)) {
    return "code_section";
  }
  return "text_section";
}

function parseDynamicMaterializationChunk(value: unknown): DynamicMaterializationChunk | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id.trim().length > 0 ? record.id.trim() : undefined;
  const title = typeof record.title === "string" && record.title.trim().length > 0 ? record.title.trim() : undefined;
  const purpose =
    typeof record.purpose === "string" && record.purpose.trim().length > 0 ? record.purpose.trim() : undefined;
  const contentKind = normalizeMaterializationChunkKind(record.content_kind);
  if (!id || !title || !purpose || !contentKind) {
    return undefined;
  }
  return {
    id,
    title,
    purpose,
    content_kind: contentKind,
    include_imports: record.include_imports === true,
    include_entrypoint: record.include_entrypoint === true,
    depends_on: Array.isArray(record.depends_on)
      ? record.depends_on.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : undefined,
    verification_focus: Array.isArray(record.verification_focus)
      ? record.verification_focus.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : undefined
  };
}

function normalizeMaterializationChunkKind(
  value: unknown
): DynamicMaterializationChunk["content_kind"] | undefined {
  return value === "code_section" ||
    value === "config_block" ||
    value === "documentation_section" ||
    value === "text_section"
    ? value
    : undefined;
}

function parseImplementBootstrapContract(value: unknown): ImplementBootstrapContract | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const requirements = Array.isArray(record.requirements)
    ? record.requirements
        .map((item) => parseImplementBootstrapRequirement(item))
        .filter((item): item is ImplementBootstrapRequirement => Boolean(item))
    : [];
  const checks = Array.isArray(record.checks)
    ? record.checks
        .map((item) => parseImplementBootstrapCheck(item))
        .filter((item): item is ImplementBootstrapCheck => Boolean(item))
    : [];
  const rawRepairContext =
    record.repair_context && typeof record.repair_context === "object"
      ? (record.repair_context as Record<string, unknown>)
      : undefined;
  const repairContext = rawRepairContext
    ? {
        failure_code: asOptionalString(rawRepairContext.failure_code),
        repair_target: asOptionalString(rawRepairContext.repair_target)
      }
    : undefined;
  if (requirements.length === 0 && checks.length === 0 && typeof record.summary !== "string") {
    return undefined;
  }
  return {
    version: asNumber(record.version) || 1,
    strategy: asOptionalString(record.strategy),
    summary: asOptionalString(record.summary),
    requires_network: record.requires_network === true,
    requires_warm_cache: record.requires_warm_cache === true,
    blocking_reason: asOptionalString(record.blocking_reason),
    remediation: asOptionalStringArray(record.remediation),
    repair_context:
      repairContext?.failure_code || repairContext?.repair_target ? repairContext : undefined,
    requirements,
    checks
  };
}

export function parseImplementBootstrapContractFromText(text: string): ImplementBootstrapContract | undefined {
  const direct = parseImplementBootstrapContract(parseJsonObject(text));
  if (direct) {
    return direct;
  }

  for (const candidate of parseJsonObjectsFromText(text)) {
    const contract = parseImplementBootstrapContract(candidate);
    if (contract) {
      return contract;
    }
  }
  return undefined;
}

function shouldRequireExplicitBootstrapPlanning(
  taskSpec: ImplementTaskSpec,
  scaffold: StructuredImplementResponse
): boolean {
  const signals = [
    taskSpec.goal,
    taskSpec.context.topic,
    taskSpec.context.plan_excerpt,
    taskSpec.context.hypotheses_excerpt,
    taskSpec.context.previous_summary || "",
    taskSpec.context.runner_feedback?.summary || "",
    scaffold.summary || "",
    scaffold.run_command || ""
  ]
    .join("\n")
    .toLowerCase();
  return (
    taskSpec.context.comparison_contract?.comparison_mode === "baseline_first_locked" ||
    /\b(?:dependency|dependencies|external assets?|download|network|warm cache|model|tokenizer|dataset|library|package)\b/u.test(
      signals
    )
  );
}

function buildDefaultImplementBootstrapContract(taskSpec: ImplementTaskSpec): ImplementBootstrapContract {
  return {
    version: 1,
    strategy: "deterministic_default",
    summary: "No explicit bootstrap risks were identified before code generation.",
    requires_network: false,
    requires_warm_cache: false,
    requirements: [],
    checks: []
  };
}

function applyDependencyRepairContextToBootstrapContract(
  contract: ImplementBootstrapContract,
  context: ImplementDependencyRepairContext | undefined
): ImplementBootstrapContract {
  if (!context) {
    return contract;
  }
  const contractText = JSON.stringify(contract).toLowerCase();
  const isDataDependency = context.failure_code === "data_dependency_unavailable";
  const mentionsDependencyRepair = isDataDependency
    ? contractText.includes("dataset") ||
      contractText.includes("data materialization") ||
      contractText.includes("schema normalization") ||
      contractText.includes("dependency-blocked")
    : contractText.includes("model") ||
      contractText.includes("tokenizer") ||
      contractText.includes("prewarm") ||
      contractText.includes("dependency-blocked") ||
      contractText.includes("available substitute");
  const remediation = dedupeStrings([
    ...(contract.remediation || []),
    ...context.retry_directives,
    context.upstream_repair_hint || ""
  ]);
  const requirements = [...contract.requirements];
  if (isDataDependency) {
    if (!requirements.some((item) => item.kind === "dataset" || item.kind === "reference_data")) {
      requirements.push({
        id: "experiment_data_dependency",
        kind: "dataset",
        source: "other",
        required_for: ["experiment_execution", "evaluation"],
        availability: "unknown",
        summary: "Task-specific data materialization must preserve the approved task, split, schema, and minimum-count contract.",
        remediation: context.upstream_repair_hint || context.retry_directives[0]
      });
    }
  } else if (!requirements.some((item) => item.kind === "model" || item.kind === "tokenizer")) {
    requirements.push({
      id: "experiment_model_tokenizer_dependency",
      kind: "model",
      source: "other",
      required_for: ["experiment_execution"],
      availability: "unknown",
      summary: "Model/tokenizer dependency must be prewarmed, substituted with an available local dependency, or marked dependency-blocked.",
      remediation: context.upstream_repair_hint || context.retry_directives[0]
    });
  }
  const blockingReason = contract.blocking_reason || (
    context.operator_action_required && !mentionsDependencyRepair
      ? isDataDependency
        ? "Experiment data dependency repair remains unresolved: preserve the approved task, split, schema, and minimum-count contract or mark the run dependency-blocked before code generation."
        : "Experiment dependency repair remains unresolved: prewarm the required model/tokenizer asset, choose a concrete available substitute, or mark the run dependency-blocked before code generation."
      : undefined
  );
  return {
    ...contract,
    strategy: contract.strategy || "dependency_repair_aware",
    summary: contract.summary || "Dependency repair context must be resolved before implementation can be trusted.",
    requires_network: contract.requires_network || context.repair_target === "environment_dependency",
    requires_warm_cache: contract.requires_warm_cache || context.failure_code === "model_dependency_unavailable",
    blocking_reason: blockingReason,
    remediation,
    repair_context: {
      failure_code: context.failure_code,
      repair_target: context.repair_target
    },
    requirements
  };
}

export function isReusableBootstrapContractCompatibleWithDependencyRepair(
  contract: ImplementBootstrapContract,
  context: ImplementDependencyRepairContext | undefined
): boolean {
  if (!context || (!context.failure_code && !context.repair_target)) {
    return true;
  }
  if (!contract.repair_context) {
    return false;
  }
  return (
    (!context.failure_code || contract.repair_context.failure_code === context.failure_code) &&
    (!context.repair_target || contract.repair_context.repair_target === context.repair_target)
  );
}

function parseImplementBootstrapRequirement(value: unknown): ImplementBootstrapRequirement | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = asOptionalString(record.id);
  const kind = normalizeBootstrapRequirementKind(record.kind);
  const source = normalizeBootstrapRequirementSource(record.source);
  const requiredFor = asOptionalStringArray(record.required_for);
  if (!id || !kind || !source || !requiredFor || requiredFor.length === 0) {
    return undefined;
  }
  return {
    id,
    kind,
    source,
    required_for: requiredFor,
    local_path: asOptionalString(record.local_path),
    availability: normalizeBootstrapAvailability(record.availability),
    summary: asOptionalString(record.summary),
    remediation: asOptionalString(record.remediation)
  };
}

function parseImplementBootstrapCheck(value: unknown): ImplementBootstrapCheck | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const id = asOptionalString(record.id);
  const checkType = normalizeBootstrapCheckType(record.check_type);
  const target = asOptionalString(record.target);
  const reason = asOptionalString(record.reason);
  if (!id || !checkType || !target || !reason) {
    return undefined;
  }
  return {
    id,
    check_type: checkType,
    target,
    reason
  };
}

function normalizeBootstrapRequirementKind(value: unknown): ImplementBootstrapRequirement["kind"] | undefined {
  const normalized = asOptionalString(value);
  return normalized === "model" ||
    normalized === "tokenizer" ||
    normalized === "dataset" ||
    normalized === "binary" ||
    normalized === "library" ||
    normalized === "reference_data" ||
    normalized === "service"
    ? normalized
    : undefined;
}

function normalizeBootstrapRequirementSource(value: unknown): ImplementBootstrapRequirement["source"] | undefined {
  const normalized = asOptionalString(value);
  return normalized === "huggingface" ||
    normalized === "local" ||
    normalized === "python" ||
    normalized === "system" ||
    normalized === "other"
    ? normalized
    : undefined;
}

function normalizeBootstrapAvailability(
  value: unknown
): ImplementBootstrapRequirement["availability"] | undefined {
  const normalized = asOptionalString(value);
  return normalized === "assumed_local" ||
    normalized === "download_required" ||
    normalized === "unknown"
    ? normalized
    : undefined;
}

function normalizeBootstrapCheckType(value: unknown): ImplementBootstrapCheck["check_type"] | undefined {
  const normalized = asOptionalString(value);
  return normalized === "path_exists" ||
    normalized === "command_available" ||
    normalized === "python_module_available"
    ? normalized
    : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return normalized.length > 0 ? normalized : undefined;
}

export async function evaluateImplementBootstrapContract(params: {
  contract: ImplementBootstrapContract;
  workspaceRoot: string;
}): Promise<{ status: "pass" | "warn" | "block"; summary: string; missing: string[] }> {
  const missing: string[] = [];
  const passedPythonModuleChecks: string[] = [];
  const missingPythonModuleChecks: string[] = [];
  for (const requirement of params.contract.requirements) {
    const localPath = normalizeStoredPath(requirement.local_path, params.workspaceRoot);
    if (localPath && !(await fileExists(localPath))) {
      if (requirement.source === "huggingface") {
        continue;
      }
      if (isLikelyGeneratedExperimentOutputPath(localPath, params.workspaceRoot)) {
        continue;
      }
      missing.push(`${requirement.id}: expected local path is missing (${formatArtifactPath(localPath, params.workspaceRoot)})`);
    }
  }

  for (const check of params.contract.checks) {
    if (check.check_type === "path_exists") {
      const targetPath = normalizeStoredPath(check.target, params.workspaceRoot);
      if (!targetPath || !(await fileExists(targetPath))) {
        if (targetPath && isLikelyGeneratedExperimentOutputPath(targetPath, params.workspaceRoot)) {
          continue;
        }
        missing.push(`${check.id}: required path is missing (${check.target})`);
      }
    } else if (check.check_type === "command_available") {
      if (!(await isBootstrapCommandAvailable(check.target, params.workspaceRoot))) {
        missing.push(`${check.id}: required command is unavailable (${check.target})`);
      }
    } else if (check.check_type === "python_module_available") {
      if (await isBootstrapPythonModuleAvailable(check.target, params.workspaceRoot)) {
        passedPythonModuleChecks.push(check.target);
      } else if (isOptionalBootstrapPythonModuleCheck(check, params.contract)) {
        continue;
      } else {
        missingPythonModuleChecks.push(check.target);
        missing.push(`${check.id}: required Python module is unavailable (${check.target})`);
      }
    }
  }

  const blockingReason = normalizeActionableBootstrapBlockingReason(params.contract.blocking_reason);
  const actionableBlockingReason =
    blockingReason &&
    isPythonPackageMissingBootstrapReason(blockingReason) &&
    passedPythonModuleChecks.length > 0 &&
    missingPythonModuleChecks.length === 0
      ? undefined
      : blockingReason;
  if (actionableBlockingReason || missing.length > 0) {
    return {
      status: "block",
      summary:
        actionableBlockingReason ||
        `Bootstrap contract failed under the current execution policy: ${missing.join("; ")}`,
      missing
    };
  }
  if (params.contract.requires_network) {
    return {
      status: "warn",
      summary:
        params.contract.summary ||
        "Bootstrap contract indicates remote assets and will proceed as a network-assisted run if fetched on demand.",
      missing
    };
  }
  return {
    status: "pass",
    summary: params.contract.summary || "Bootstrap contract is compatible with the current execution policy.",
    missing
  };
}

async function isBootstrapCommandAvailable(command: string, cwd: string): Promise<boolean> {
  const normalized = command.trim();
  if (!/^[A-Za-z0-9_.+/-]+$/u.test(normalized)) {
    return false;
  }
  try {
    await execFile("which", [normalized], { cwd, timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function isBootstrapPythonModuleAvailable(moduleName: string, cwd: string): Promise<boolean> {
  const normalized = moduleName.trim();
  if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/u.test(normalized)) {
    return false;
  }
  const commands = ["python3", "python"];
  const script = [
    "import importlib",
    `importlib.import_module(${JSON.stringify(normalized)})`
  ].join("; ");
  for (const command of commands) {
    try {
      await execFile(command, ["-c", script], { cwd, timeout: 60_000 });
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

function isPythonPackageMissingBootstrapReason(reason: string): boolean {
  const lower = reason.toLowerCase();
  return (
    lower.includes("missing required python package") ||
    lower.includes("missing required python packages") ||
    lower.includes("missing python package") ||
    lower.includes("missing python packages")
  );
}

function isOptionalBootstrapPythonModuleCheck(
  check: ImplementBootstrapCheck,
  contract: ImplementBootstrapContract
): boolean {
  const target = check.target.trim().toLowerCase();
  const relatedRequirements = contract.requirements.filter((requirement) => {
    if (requirement.kind !== "library" || requirement.source !== "python") {
      return false;
    }
    const haystack = [
      requirement.id,
      requirement.summary || "",
      requirement.remediation || "",
      ...requirement.required_for
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(target);
  });
  const text = [
    check.reason,
    ...relatedRequirements.flatMap((requirement) => [
      requirement.summary || "",
      requirement.remediation || "",
      ...requirement.required_for
    ])
  ]
    .join(" ")
    .toLowerCase();
  if (
    ["sklearn", "scikit_learn", "scikit-learn"].includes(target) &&
    /\b(?:metric|metrics|scoring|score|evaluation_metrics)\b/u.test(text)
  ) {
    return true;
  }
  if (
    (target === "scipy" || target.includes("scipy")) &&
    /\b(?:ci|confidence intervals?|intervals?|statistical|statistics|variance|standard error|summary|summaries)\b/u.test(text)
  ) {
    return true;
  }

  return (
    /\b(optional|if used|when used|only if used|useful for|nice-to-have|non-blocking)\b/u.test(text) ||
    /\b(?:if|when)\s+(?:the\s+)?(?:selected|fallback|chosen|configured|active|runtime)\b/u.test(text)
  );
}

function isLikelyGeneratedExperimentOutputPath(filePath: string, workspaceRoot: string): boolean {
  if (!isPathInsideOrEqual(filePath, workspaceRoot)) {
    return false;
  }
  const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/g, "/");
  if (!relativePath.startsWith("outputs/") || !relativePath.includes("/experiment/")) {
    return false;
  }
  const basename = path.basename(filePath).toLowerCase();
  return (
    basename.endsWith(".py") ||
    /(?:^|_)(?:baseline|bootstrap|condition|conditions|experiment|manifest|metrics|portfolio|result|results|run|study|summary|verify)(?:_|\.|$)/u.test(
      basename
    )
  );
}

function normalizeActionableBootstrapBlockingReason(reason: string | undefined): string | undefined {
  if (!reason) {
    return undefined;
  }
  const normalized = reason.trim();
  const lower = normalized.toLowerCase();
  if (
    lower.includes("no known non-network blocker") ||
    lower.includes("no known non network blocker") ||
    lower.includes("no concrete non-network blocker") ||
    lower.includes("no concrete non network blocker")
  ) {
    return undefined;
  }
  const uncertaintySignals = [
    "none known except",
    "if network access is unavailable",
    "if ",
    "if torch",
    "if the",
    "unless",
    "may fail",
    "might fail",
    "could fail",
    "availability is unknown",
    "unknown"
  ];
  const concreteBlockSignals = [
    "is missing",
    "not found",
    "does not exist",
    "unavailable",
    "cannot execute",
    "permission denied",
    "requires manual",
    "blocked by policy"
  ];
  const describesUncertainty = uncertaintySignals.some((signal) => lower.includes(signal));
  const describesConcreteBlock = concreteBlockSignals.some((signal) => lower.includes(signal));
  if (describesUncertainty && !describesConcreteBlock) {
    return undefined;
  }
  return normalized;
}

function shouldUseSectionedSkeletonForTarget(filePath: string): boolean {
  return isPythonMaterializationPath(filePath);
}

function isPythonMaterializationPath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === ".py";
}

function buildCanonicalSectionedSkeleton(params: {
  filePath: string;
  unit: DynamicDecompositionUnit;
  materializationPlan: DynamicMaterializationPlan;
  sections: PlannedMaterializationSection[];
}): string {
  const commentPrefix = isPythonMaterializationPath(params.filePath) ? "# " : "";
  const header = [
    `${commentPrefix}AUTOLABOS CANONICAL SKELETON`,
    `${commentPrefix}Target: ${params.filePath}`,
    `${commentPrefix}Unit: ${params.unit.title}`,
    `${commentPrefix}Strategy: ${params.materializationPlan.strategy || "dynamic_materialization"}`,
    ""
  ];
  const sectionBlocks = params.sections.flatMap((entry, index) => [
    `${commentPrefix}BEGIN AUTOLABOS SECTION ${entry.section.id} :: ${entry.section.title}`,
    `${commentPrefix}Purpose: ${entry.section.purpose}`,
    `${commentPrefix}Order: ${index + 1}/${params.sections.length}`,
    `${commentPrefix}END AUTOLABOS SECTION ${entry.section.id}`,
    ""
  ]);
  return [...header, ...sectionBlocks].join("\n").trimEnd() + "\n";
}

function applySectionContentToCanonicalSkeleton(
  skeleton: string,
  sectionId: string,
  sectionContent: string,
  filePath: string
): string {
  const commentPrefix = isPythonMaterializationPath(filePath) ? "# " : "";
  const startMarkerPattern = new RegExp(
    `${escapeRegex(`${commentPrefix}BEGIN AUTOLABOS SECTION ${sectionId}`)}[^\\n]*\\n${escapeRegex(commentPrefix)}Purpose:[^\\n]*\\n${escapeRegex(commentPrefix)}Order:[^\\n]*\\n`,
    "u"
  );
  const endMarker = `${commentPrefix}END AUTOLABOS SECTION ${sectionId}`;
  const startMatch = skeleton.match(startMarkerPattern);
  if (!startMatch || startMatch.index == null) {
    throw new Error(`canonical skeleton is missing section marker for ${sectionId}`);
  }
  const contentStart = startMatch.index + startMatch[0].length;
  const endIndex = skeleton.indexOf(endMarker, contentStart);
  if (endIndex < 0) {
    throw new Error(`canonical skeleton is missing end marker for ${sectionId}`);
  }
  return `${skeleton.slice(0, contentStart)}${sectionContent.trimEnd()}\n${skeleton.slice(endIndex)}`;
}

function stripCanonicalSkeletonMarkers(content: string, filePath: string): string {
  const commentPrefix = isPythonMaterializationPath(filePath) ? "# " : "";
  const stripped = content
    .split("\n")
    .filter((line) => {
      const normalizedLine = line.trimStart();
      return !normalizedLine.startsWith(`${commentPrefix}AUTOLABOS CANONICAL SKELETON`) &&
        !normalizedLine.startsWith(`${commentPrefix}Target:`) &&
        !normalizedLine.startsWith(`${commentPrefix}Unit:`) &&
        !normalizedLine.startsWith(`${commentPrefix}Strategy:`) &&
        !normalizedLine.startsWith(`${commentPrefix}BEGIN AUTOLABOS SECTION`) &&
        !normalizedLine.startsWith(`${commentPrefix}Purpose:`) &&
        !normalizedLine.startsWith(`${commentPrefix}Order:`) &&
        !normalizedLine.startsWith(`${commentPrefix}END AUTOLABOS SECTION`);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return stripped.length > 0 ? `${stripped}\n` : "";
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isMaterializableTextUnit(unit: DynamicDecompositionUnit): boolean {
  return unit.generation_mode === "materialize_text_file" && typeof unit.target_path === "string" && unit.target_path.length > 0;
}

function compactDraftForChunkPrompt(draft: string): { has_content: boolean; excerpt?: string } {
  const trimmed = draft.trim();
  if (!trimmed) {
    return { has_content: false };
  }
  return {
    has_content: true,
    excerpt: trimBlock(trimmed, 4000)
  };
}

function appendDraftSection(draft: string, section: string): string {
  return draft.trim().length > 0 ? `${draft.trimEnd()}\n\n${section.trimStart()}` : section;
}

function sanitizeArtifactId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function parseStructuredFileEditResponse(
  text: string,
  workspaceRoot: string,
  expectedPath: string
): StructuredImplementFileEdit {
  const parsed = parseJsonObject(text);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`staged_llm file generation for ${expectedPath} did not return a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  const normalizedPath = normalizeStoredPath(asString(record.path) || expectedPath, workspaceRoot);
  const content = asString(record.content);
  if (!normalizedPath || content === undefined) {
    throw new Error(`staged_llm file generation for ${expectedPath} omitted path/content`);
  }
  return {
    path: normalizedPath,
    content
  };
}

async function materializeStructuredFileEdits(fileEdits: StructuredImplementFileEdit[]): Promise<void> {
  for (const item of fileEdits) {
    await ensureDir(path.dirname(item.path));
    await fs.writeFile(item.path, item.content, "utf8");
  }
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {
      // continue
    }
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function parseJsonObjectsFromText(text: string): unknown[] {
  const candidates: unknown[] = [];
  for (const candidateText of extractBalancedJsonObjectStrings(text)) {
    try {
      candidates.push(JSON.parse(candidateText));
    } catch {
      // Ignore non-JSON brace spans and keep scanning for a schema-valid object.
    }
  }
  return candidates;
}

function extractBalancedJsonObjectStrings(text: string): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    const candidate = extractBalancedJsonObjectStringFrom(text, start);
    if (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      results.push(candidate);
    }
  }
  return results;
}

function extractBalancedJsonObjectStringFrom(text: string, start: number): string | undefined {
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
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

function normalizeStoredPath(filePath: string | undefined, workspaceRoot: string): string | undefined {
  if (!filePath) {
    return undefined;
  }
  const candidate = mapAliasedWorkspacePathToPrimary(filePath, workspaceRoot);
  const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(workspaceRoot, candidate);
  if (!isPathInsideOrEqual(resolved, workspaceRoot)) {
    return undefined;
  }
  return resolved;
}

function trimBlock(text: string, limit: number): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, limit)}\n...<truncated>`;
}

function deriveImplementDependencyRepairContext(input: {
  plan?: string;
  runnerFeedback?: RunVerifierReport;
}): ImplementDependencyRepairContext | undefined {
  const text = [input.plan || "", JSON.stringify(input.runnerFeedback || {})].join("\n");
  const failureCode = input.runnerFeedback?.failure_code || extractYamlScalar(text, "run_verifier_failure_code");
  const repairTarget = input.runnerFeedback?.repair_target || extractYamlScalar(text, "run_verifier_repair_target");
  const isModelDependency = failureCode === "model_dependency_unavailable" || repairTarget === "environment_dependency";
  const isDataDependency = failureCode === "data_dependency_unavailable";
  if (!isModelDependency && !isDataDependency) {
    return undefined;
  }
  const directives = extractDependencyRepairDirectives(text).filter((directive) =>
    isDataDependency
      ? /(?:task-specific data|data materialization|schema normalization|minimum-count evidence floor)/iu.test(directive)
      : /(?:model|tokenizer|prewarm|available local dependency|known available substitute)/iu.test(directive)
  );
  return {
    failure_code: failureCode,
    repair_target: repairTarget,
    recommended_backtrack_node:
      input.runnerFeedback?.recommended_backtrack_node || extractYamlScalar(text, "run_verifier_recommended_backtrack_node"),
    upstream_repair_hint:
      input.runnerFeedback?.upstream_repair_hint || extractYamlScalar(text, "run_verifier_upstream_repair_hint"),
    operator_action_required:
      input.runnerFeedback?.operator_action_required ?? extractYamlBoolean(text, "run_verifier_operator_action_required"),
    retry_directives: directives.length > 0
      ? directives
      : isDataDependency
        ? [
            "Repair task-specific data materialization and schema normalization without lowering the approved task, split, or minimum-count evidence floor."
          ]
        : [
            "Do not repeat a design that depends on an unavailable model/tokenizer asset; select an explicitly available local dependency or mark the run dependency-blocked before implementation."
          ]
  };
}

function extractDependencyRepairDirectives(text: string): string[] {
  return dedupeStrings(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /^[-*]\s+/u.test(line))
      .map((line) => line.replace(/^[-*]\s*/, "").replace(/^['"]|['"]$/gu, ""))
      .filter((line) =>
        /(?:unavailable model\/tokenizer|dependency repair|dependency-blocked|prewarm|available local dependency|known available substitute)/iu.test(line)
      )
      .map((line) => trimBlock(line, 320))
  ).slice(0, 6);
}

function extractYamlScalar(text: string, key: string): string | undefined {
  const prefix = key + ":";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(prefix)) {
      continue;
    }
    const raw = trimmed.slice(prefix.length).trim().replace(/,$/u, "");
    return raw.replace(/^['"]|['"]$/gu, "").trim() || undefined;
  }
  return undefined;
}

function extractYamlBoolean(text: string, key: string): boolean | undefined {
  const value = extractYamlScalar(text, key)?.toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export function derivePlannedConditionContract(input: {
  plan?: string;
  brief?: string;
  preferBriefContract?: boolean;
  objectiveMetric: string;
}): PlannedConditionContract | undefined {
  const planContractText = extractSelectedDesignContractText(input.plan) || input.plan;
  const briefContractText = input.brief || "";
  const briefConditionSet = extractPlannedConditionSet(briefContractText);
  const briefHasSpecificContract = Boolean(
    input.brief?.trim() &&
      (briefConditionSet.markers.length > 0 ||
        parseRepeatedSeedRunContract(briefContractText) ||
        extractSeedSchedule(briefContractText).length > 0 ||
        parsePlannedConditionContractCount(briefContractText, briefConditionSet.markers.length))
  );
  const planContractSource = planContractText || "";
  const planConditionSet = extractPlannedConditionSet(planContractSource);
  const planHasSpecificContract = Boolean(
    input.plan?.trim() &&
      (planConditionSet.markers.length > 0 ||
        parseRepeatedSeedRunContract(planContractSource) ||
        extractSeedSchedule(planContractSource).length > 1 ||
        parsePlannedConditionContractCount(planContractSource, planConditionSet.markers.length))
  );
  const redesignedPlanContractOverridesFrozenBrief = Boolean(
    planHasSpecificContract &&
      /(?:^|\n)\s*retry_context\s*:|\bbacktrack_to_|\btransition_action\s*:|\btransition_reason\s*:|\bprevious_objective_status\s*:/iu.test(
        input.plan || ""
      )
  );
  const selectedContractText = input.preferBriefContract && briefHasSpecificContract && !redesignedPlanContractOverridesFrozenBrief
    ? briefContractText
    : planHasSpecificContract
      ? planContractSource
      : [input.plan, input.brief].filter(Boolean).join("\n");
  const text = [selectedContractText, input.objectiveMetric].filter(Boolean).join("\n");
  if (!text.trim()) {
    return undefined;
  }
  const conditionSet = extractPlannedConditionSet(selectedContractText);
  const conditionMarkers = conditionSet.markers;
  const repeatedRunContract = parseRepeatedSeedRunContract(text);
  const explicitTrainingRunCount = parseExplicitTrainingRunCount(text);
  const seedSchedule = extractSeedSchedule(text);
  const evaluationContract = mergeFullEvaluationContracts(
    parseFullEvaluationContract(text),
    planHasSpecificContract ? parseFullEvaluationContract(planContractSource) : undefined
  );
  const baselineConditionMarker = conditionSet.baselineMarker;
  const requiredCountFromText =
    repeatedRunContract?.cellCount ||
    parsePlannedConditionContractCount(text, conditionMarkers.length);
  const conditionMarkerCount = conditionMarkers.length >= 2
    ? conditionMarkers.length
    : undefined;
  const explicitRunTotalMatchesMarkerSeedProduct = Boolean(
    explicitTrainingRunCount !== undefined &&
      conditionMarkerCount !== undefined &&
      seedSchedule.length > 1 &&
      explicitTrainingRunCount === conditionMarkerCount * seedSchedule.length
  );
  const requiredCount =
    explicitRunTotalMatchesMarkerSeedProduct
      ? conditionMarkerCount
      : requiredCountFromText || conditionMarkerCount;
  const inferredRepeatedRunCount =
    repeatedRunContract?.runCount ||
    (explicitRunTotalMatchesMarkerSeedProduct ? explicitTrainingRunCount : undefined) ||
    (requiredCount && seedSchedule.length > 1 ? requiredCount * seedSchedule.length : undefined);
  const inferredMinimumSeedsPerCondition =
    repeatedRunContract?.seedsPerCell || (seedSchedule.length > 1 ? seedSchedule.length : undefined);
  const primaryMetricKey = extractPrimaryMetricKey(input.objectiveMetric) || extractPrimaryMetricKey(text);
  if (conditionMarkers.length === 0 && requiredCount === undefined && !primaryMetricKey) {
    return undefined;
  }
  let markerList = [...conditionMarkers];
  if (baselineConditionMarker && markerList.includes(baselineConditionMarker)) {
    markerList = [
      baselineConditionMarker,
      ...markerList.filter((marker) => marker !== baselineConditionMarker)
    ];
  }
  const notes = [
    "Derived from the governed plan/brief text; implement_experiments must preserve these planned condition semantics.",
    "If a marker cannot run because the installed stack lacks support, record that condition as failed with evidence rather than substituting a different candidate configuration."
  ];
  if (repeatedRunContract || seedSchedule.length > 0) {
    notes.push(
      "This is a repeated-seed evidence-scale contract. Do not compress repeated cells or seed schedules into a single pilot condition or aggregate condition marker.",
      "The runner must emit per-seed/per-condition rows plus aggregate variance or confidence-interval fields when the plan asks for repeated-run evidence."
    );
  }
  return {
    required_condition_count: requiredCount,
    required_run_count: inferredRepeatedRunCount,
    seed_schedule: seedSchedule.length > 0 ? seedSchedule : undefined,
    minimum_seeds_per_condition: inferredMinimumSeedsPerCondition,
    baseline_condition_marker: baselineConditionMarker,
    required_condition_markers: markerList,
    primary_metric_key: primaryMetricKey,
    full_evaluation_required: evaluationContract.fullEvaluationRequired || undefined,
    minimum_eval_examples_per_task:
      Object.keys(evaluationContract.minimumEvalExamplesPerTask).length > 0
        ? evaluationContract.minimumEvalExamplesPerTask
        : undefined,
    notes
  };
}
function extractSelectedDesignContractText(plan?: string): string | undefined {
  if (!plan?.trim()) {
    return undefined;
  }
  const selectedMatch = /(?:^|\n)selected_design:\s*(?:\n|$)/iu.exec(plan);
  if (!selectedMatch || selectedMatch.index === undefined) {
    return undefined;
  }
  const start = selectedMatch.index + (selectedMatch[0].startsWith("\n") ? 1 : 0);
  const rest = plan.slice(start);
  const stopMatch = /\n(?:shortlisted_designs|execution|dropped_hypotheses|hypothesis_filter):\s*(?:\n|$)/iu.exec(rest);
  const selectedBlock = stopMatch?.index !== undefined ? rest.slice(0, stopMatch.index) : rest;
  return selectedBlock.trim() || undefined;
}

interface ExtractedPlannedConditionSet {
  markers: string[];
  baselineMarker?: string;
}

interface PlannedConditionBaselineCandidate {
  marker: string;
  priority: number;
}

function extractPlannedConditionSet(text: string): ExtractedPlannedConditionSet {
  if (!text.trim()) {
    return { markers: [] };
  }
  const structured = extractStructuredPlannedConditionSet(text);
  const fallback = extractTextFallbackPlannedConditionSet(text);
  let markers = dedupeStrings(
    structured && structured.markers.length > 0
      ? structured.markers
      : fallback.markers
  ).slice(0, 128);
  const explicitBaselineMarker = structured?.baselineMarker || fallback.baselineMarker;
  const baselineMarker = explicitBaselineMarker || markers.find(isBaselineMeaningConditionMarker);
  if (baselineMarker && !markers.includes(baselineMarker)) {
    markers = [baselineMarker, ...markers].slice(0, 128);
  }
  if (baselineMarker && markers.includes(baselineMarker)) {
    markers = [baselineMarker, ...markers.filter((marker) => marker !== baselineMarker)];
  }
  return {
    markers,
    baselineMarker
  };
}

function extractStructuredPlannedConditionSet(text: string): ExtractedPlannedConditionSet | undefined {
  let parsed: unknown;
  try {
    parsed = YAML.parse(text, {
      logLevel: "silent",
      maxAliasCount: 20,
      uniqueKeys: true
    }) as unknown;
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) && !isPlannedConditionRecord(parsed)) {
    return undefined;
  }

  const markers: string[] = [];
  let baselineCandidate: PlannedConditionBaselineCandidate | undefined;
  const visited = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 12 || (!Array.isArray(value) && !isPlannedConditionRecord(value))) {
      return;
    }
    if (visited.has(value)) {
      return;
    }
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, depth + 1);
      }
      return;
    }

    for (const [rawKey, nested] of Object.entries(value)) {
      const key = normalizePlannedConditionKey(rawKey);
      if (isConditionCollectionKey(key)) {
        markers.push(...extractConditionMarkersFromValue(nested));
        continue;
      }
      const priority = baselineConditionKeyPriority(key);
      if (priority !== undefined) {
        const marker = canonicalPlannedConditionMarkerFromScalar(nested);
        if (marker && (!baselineCandidate || priority < baselineCandidate.priority)) {
          baselineCandidate = { marker, priority };
        }
      }
    }
    for (const [rawKey, nested] of Object.entries(value)) {
      if (!isConditionCollectionKey(normalizePlannedConditionKey(rawKey))) {
        visit(nested, depth + 1);
      }
    }
  };

  visit(parsed, 0);
  if (markers.length === 0 && !baselineCandidate) {
    return undefined;
  }
  return {
    markers: dedupeStrings(markers),
    baselineMarker: baselineCandidate?.marker
  };
}

function extractTextFallbackPlannedConditionSet(text: string): ExtractedPlannedConditionSet {
  const markers: string[] = [];
  let baselineCandidate: PlannedConditionBaselineCandidate | undefined;
  const lines = text.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] || "";
    const conditionMatch = /^\s*(?:[-*]\s*)?conditions?\s*:\s*(.*?)\s*$/iu.exec(line);
    if (conditionMatch) {
      const inlineValue = (conditionMatch[1] || "").trim();
      if (inlineValue) {
        markers.push(...extractConditionMarkersFromValue(inlineValue));
      } else {
        const keyIndent = leadingWhitespaceLength(line);
        const blockLines: string[] = [];
        let nextIndex = index + 1;
        for (; nextIndex < lines.length; nextIndex += 1) {
          const nextLine = lines[nextIndex] || "";
          if (!nextLine.trim()) {
            blockLines.push(nextLine);
            continue;
          }
          const nextIndent = leadingWhitespaceLength(nextLine);
          const sameIndentListItem = nextIndent === keyIndent && /^\s*[-*]\s+/u.test(nextLine);
          if (nextIndent < keyIndent || (nextIndent === keyIndent && !sameIndentListItem)) {
            break;
          }
          blockLines.push(nextLine);
        }
        if (blockLines.some((blockLine) => blockLine.trim())) {
          const nonEmptyIndents = blockLines
            .filter((blockLine) => blockLine.trim())
            .map(leadingWhitespaceLength);
          const minimumIndent = Math.min(...nonEmptyIndents);
          const normalizedBlock = blockLines
            .map((blockLine) => blockLine.trim()
              ? "  " + blockLine.slice(minimumIndent)
              : "")
            .join("\n");
          const parsedBlock = extractStructuredPlannedConditionSet("conditions:\n" + normalizedBlock);
          if (parsedBlock) {
            markers.push(...parsedBlock.markers);
          } else {
            for (const blockLine of blockLines) {
              const itemMatch = /^\s*[-*]\s*(.+)$/u.exec(blockLine);
              if (itemMatch) {
                markers.push(...extractConditionMarkersFromValue(itemMatch[1] || ""));
              }
            }
          }
        }
        index = nextIndex - 1;
      }
    }

    const baselineMatch = /^\s*(?:[-*]\s*)?(baseline_condition_marker|baseline_condition_id|baseline)\s*:\s*(.*?)\s*$/iu.exec(line);
    if (baselineMatch) {
      const priority = baselineConditionKeyPriority(normalizePlannedConditionKey(baselineMatch[1] || ""));
      const marker = canonicalPlannedConditionMarkerFromScalar(baselineMatch[2]);
      if (priority !== undefined && marker && (!baselineCandidate || priority < baselineCandidate.priority)) {
        baselineCandidate = { marker, priority };
      }
    }
  }

  return {
    markers: dedupeStrings(markers),
    baselineMarker: baselineCandidate?.marker
  };
}

function extractConditionMarkersFromValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(extractConditionMarkersFromValue);
  }
  if (isPlannedConditionRecord(value)) {
    const entries = Object.entries(value);
    const idEntry = entries.find(([key]) => normalizePlannedConditionKey(key) === "condition_id") ||
      entries.find(([key]) => normalizePlannedConditionKey(key) === "id");
    const marker = idEntry ? canonicalPlannedConditionMarkerFromScalar(idEntry[1]) : undefined;
    if (marker) {
      return [marker];
    }
    if (entries.length > 0 && entries.every(([, nested]) => nested === null)) {
      return entries
        .map(([key]) => canonicalPlannedConditionMarker(key))
        .filter((candidate): candidate is string => Boolean(candidate));
    }
    return [];
  }
  if (typeof value === "number") {
    const marker = canonicalPlannedConditionMarker(String(value));
    return marker ? [marker] : [];
  }
  if (typeof value !== "string") {
    return [];
  }

  let raw = value.trim();
  if (!raw) {
    return [];
  }
  if ((raw.startsWith("[") && raw.endsWith("]")) || (raw.startsWith("{") && raw.endsWith("}"))) {
    try {
      const parsed = YAML.parse(raw, {
        logLevel: "silent",
        maxAliasCount: 20,
        uniqueKeys: true
      }) as unknown;
      if (parsed !== raw && (Array.isArray(parsed) || isPlannedConditionRecord(parsed))) {
        const parsedMarkers = extractConditionMarkersFromValue(parsed);
        if (parsedMarkers.length > 0) {
          return parsedMarkers;
        }
      }
    } catch {
      // The conservative delimiter parser below handles simple JSON-like lists.
    }
    raw = raw.slice(1, -1).trim();
  }

  const objectIdMatch = /^(?:condition_id|id)\s*:\s*(.+)$/iu.exec(raw);
  if (objectIdMatch) {
    const marker = canonicalPlannedConditionMarker(objectIdMatch[1] || "");
    return marker ? [marker] : [];
  }
  return splitTopLevelConditionList(raw)
    .map(canonicalPlannedConditionMarker)
    .filter((candidate): candidate is string => Boolean(candidate));
}

function splitTopLevelConditionList(value: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  let depth = 0;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote) {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) {
        quote = "";
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "[" || character === "{" || character === "(") {
      depth += 1;
      current += character;
      continue;
    }
    if (character === "]" || character === "}" || character === ")") {
      depth = Math.max(0, depth - 1);
      current += character;
      continue;
    }
    if (depth === 0 && (character === ";" || character === ",")) {
      if (current.trim()) {
        items.push(current.trim());
      }
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) {
    items.push(current.trim());
  }
  return items;
}

function canonicalPlannedConditionMarker(value: string): string | undefined {
  const unquoted = value
    .trim()
    .replace(/^[-*]\s*/u, "")
    .replace(/\s+#.*$/u, "")
    .replace(/^["']+|["']+$/gu, "")
    .trim();
  if (!unquoted || /^(?:true|false|null|undefined|conditions?)$/iu.test(unquoted)) {
    return undefined;
  }
  const slug = unquoted
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 64);
  return slug || undefined;
}

function canonicalPlannedConditionMarkerFromScalar(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }
  const raw = String(value).trim();
  if (!raw || /[;,]/u.test(raw) || /^[\[{]/u.test(raw)) {
    return undefined;
  }
  return canonicalPlannedConditionMarker(raw);
}

function isBaselineMeaningConditionMarker(marker: string): boolean {
  return /(?:^|_)(?:baseline|control|reference)(?:_|$)/u.test(marker);
}

function isPlannedConditionRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePlannedConditionKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
}

function isConditionCollectionKey(key: string): boolean {
  return key === "conditions" || key === "condition_list" || key === "condition_ids" || key === "condition_labels";
}

function baselineConditionKeyPriority(key: string): number | undefined {
  if (key === "baseline_condition_marker") return 0;
  if (key === "baseline_condition_id") return 1;
  if (key === "baseline") return 2;
  return undefined;
}

function leadingWhitespaceLength(value: string): number {
  return /^\s*/u.exec(value)?.[0].length || 0;
}

function parsePlannedConditionContractCount(text: string, listedConditionCount = 0): number | undefined {
  const numericMatch =
    text.match(/\b(\d+)\s+conditions?\s+x\b/iu) ||
    text.match(/\b(?:exactly\s+)?(\d+)\s+(?:planned\s+)?(?:experimental\s+)?conditions\b/iu) ||
    text.match(/\bno\s+more\s+than\s+(\d+)\s+experimental\s+conditions?\b/iu);
  if (numericMatch) {
    const parsed = Number.parseInt(numericMatch[1] || "", 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return listedConditionCount >= 2 ? listedConditionCount : undefined;
}
function parseRepeatedSeedRunContract(
  text: string
): { cellCount?: number; seedsPerCell?: number; runCount?: number } | undefined {
  const explicitRuns =
    text.match(/\bexecute\s+(\d+)\s+(?:train[-\s]?plus[-\s]?eval|train[-\s]?and[-\s]?eval|training[-\s]?and[-\s]?evaluation)?\s*runs?\s+total\b/iu) ||
    text.match(/\b(\d+)\s+runs?\s+total\b/iu) ||
    text.match(/\btotal\s+planned\s+(?:train\/eval|train[-\s]?eval|train[-\s]?and[-\s]?eval|training[-\s]?and[-\s]?evaluation)\s+jobs?\s*[:=]\s*(\d+)\b/iu) ||
    text.match(/\b(?:train\/eval|train[-\s]?eval|train[-\s]?and[-\s]?eval|training[-\s]?and[-\s]?evaluation)\s+(?:jobs?|runs?)\s+total\s*[:=]?\s*(\d+)\b/iu);
  const conditionsPerSeedMatch =
    text.match(/\btotal\s+training\s+conditions?\s+per\s+seed\s*[:=]\s*(\d+)\b/iu) ||
    text.match(/\bconditions?\s+per\s+seed\s*[:=]\s*(\d+)\b/iu);
  const cellSeedMatch =
    text.match(/\b(\d+)[^\n.]{0,48}\bconditions?\s*[x×]\s*(\d+)\s+(?:completed\s+|paired\s+)?seeds?\b/iu) ||
    text.match(/\b(\d+)\s+repeated\s+cells?\s*[x×]\s*(\d+)[-\s]*(?:paired\s+)?seeds?\b/iu) ||
    text.match(/\b(\d+)[-\s]*(?:parameter\s+)?cells?\s*[x×]\s*(\d+)[-\s]*(?:paired\s+)?seeds?\b/iu);
  const cellCount = cellSeedMatch
    ? Number.parseInt(cellSeedMatch[1] || "", 10)
    : conditionsPerSeedMatch
      ? Number.parseInt(conditionsPerSeedMatch[1] || "", 10)
      : undefined;
  const seedsPerCell = cellSeedMatch ? Number.parseInt(cellSeedMatch[2] || "", 10) : undefined;
  const runCount = explicitRuns
    ? Number.parseInt(explicitRuns[1] || "", 10)
    : cellCount && seedsPerCell
      ? cellCount * seedsPerCell
      : undefined;
  const normalizedCellCount = Number.isFinite(cellCount) && (cellCount || 0) > 0 ? cellCount : undefined;
  const normalizedSeedsPerCell = Number.isFinite(seedsPerCell) && (seedsPerCell || 0) > 0 ? seedsPerCell : undefined;
  const normalizedRunCount = Number.isFinite(runCount) && (runCount || 0) > 0 ? runCount : undefined;
  if (!normalizedCellCount && !normalizedSeedsPerCell && !normalizedRunCount) {
    return undefined;
  }
  return {
    cellCount: normalizedCellCount,
    seedsPerCell: normalizedSeedsPerCell,
    runCount: normalizedRunCount
  };
}

function parseExplicitTrainingRunCount(text: string): number | undefined {
  const patterns = [
    /\b(\d+)\s+(?:[A-Za-z][A-Za-z0-9_-]*\s+){0,5}(?:training|train[-\s]?eval|train[-\s]?and[-\s]?eval|fine[-\s]?tune|finetune|execution)\s+runs?\b/iu,
    /\b(?:required|planned|completed)\s+(?:training|train[-\s]?eval|train[-\s]?and[-\s]?eval|fine[-\s]?tune|finetune|execution)\s+runs?\s*[:=]\s*(\d+)\b/iu
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const parsed = match ? Number.parseInt(match[1] || "", 10) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return undefined;
}

function extractSeedSchedule(text: string): number[] {
  const seeds = new Set<number>();
  for (const match of text.matchAll(/\b(?:seeds?|seed\s+schedule)\s*(?:(?:must\s+be\s+)?exactly\s*)?(?:=|:)?\s*\[([0-9,\s]+)\]/giu)) {
    const raw = match[1] || "";
    for (const token of raw.split(",")) {
      const parsed = Number.parseInt(token.trim(), 10);
      if (Number.isFinite(parsed)) {
        seeds.add(parsed);
      }
    }
  }
  for (const match of text.matchAll(/\bseeds?\s*(?:=|:)?\s*\{([0-9,\s]+)\}/giu)) {
    const raw = match[1] || "";
    for (const token of raw.split(",")) {
      const parsed = Number.parseInt(token.trim(), 10);
      if (Number.isFinite(parsed)) {
        seeds.add(parsed);
      }
    }
  }
  for (const match of text.matchAll(
    /\bseeds?\s*(?:=|:)?\s+(\d+(?:\s*,\s*(?:and\s+)?\d+)+(?:\s*,?\s*and\s+\d+)?|\d+\s+and\s+\d+)/giu
  )) {
    const raw = match[1] || "";
    const parsedSeeds = [...raw.matchAll(/\b\d+\b/gu)]
      .map((seedMatch) => Number.parseInt(seedMatch[0], 10))
      .filter((parsed) => Number.isFinite(parsed));
    if (parsedSeeds.length < 2) {
      continue;
    }
    for (const seed of parsedSeeds) {
      seeds.add(seed);
    }
  }
  return [...seeds].sort((left, right) => left - right);
}

function parseFullEvaluationContract(text: string): {
  fullEvaluationRequired: boolean;
  minimumEvalExamplesPerTask: Record<string, number>;
} {
  const lower = text.toLowerCase();
  const fullEvaluationRequired =
    /\bfull\b[\s\S]{0,120}\b(?:benchmark|task|validation|evaluation)\b/iu.test(text) ||
    /\b(?:benchmark|task)\b[\s\S]{0,120}\bfull\b[\s\S]{0,120}\b(?:validation|evaluation|split|set)s?\b/iu.test(text);
  const minimumEvalExamplesPerTask = extractNamedTaskEvaluationCounts(text);
  if (Object.keys(minimumEvalExamplesPerTask).length === 0) {
    const taskCount = extractTaskEvaluationCount(text, ["benchmark", "task", "evaluation"]);
    if (taskCount !== undefined) {
      minimumEvalExamplesPerTask.benchmark_task = taskCount;
    }
  }
  if (
    /\bfull\b/u.test(lower) &&
    (Object.keys(minimumEvalExamplesPerTask).length > 0 ||
      /\b(?:benchmark|task)\b[\s\S]{0,160}\bvalidation\s+(?:sets?|splits?)\b/iu.test(text))
  ) {
    return { fullEvaluationRequired: true, minimumEvalExamplesPerTask };
  }
  return { fullEvaluationRequired, minimumEvalExamplesPerTask };
}

function mergeFullEvaluationContracts(
  primary: ReturnType<typeof parseFullEvaluationContract>,
  planContract: ReturnType<typeof parseFullEvaluationContract> | undefined
): ReturnType<typeof parseFullEvaluationContract> {
  if (!planContract) {
    return primary;
  }
  const minimumEvalExamplesPerTask = {
    ...primary.minimumEvalExamplesPerTask,
    ...planContract.minimumEvalExamplesPerTask
  };
  const namedTaskKeys = Object.keys(minimumEvalExamplesPerTask).filter((key) => key !== "benchmark_task");
  if (namedTaskKeys.length > 0) {
    delete minimumEvalExamplesPerTask.benchmark_task;
  }
  return {
    fullEvaluationRequired: primary.fullEvaluationRequired || planContract.fullEvaluationRequired,
    minimumEvalExamplesPerTask
  };
}

function extractNamedTaskEvaluationCounts(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of text.split(/\r?\n/u)) {
    if (!/\bn\s*=\s*\d[\d,]*\b/iu.test(line)) {
      continue;
    }
    const segments = line.split(/\s+and\s+(?=(?:full\s+)?[^;]{1,100}\bn\s*=\s*\d[\d,]*\b)/giu);
    for (const rawSegment of segments) {
      const countMatch = /\bn\s*=\s*(\d[\d,]*)\b/iu.exec(rawSegment);
      const count = countMatch ? parseGroupedPositiveInteger(countMatch[1] || "") : undefined;
      if (count === undefined) {
        continue;
      }
      const prefix = rawSegment
        .slice(0, countMatch?.index ?? rawSegment.length)
        .replace(/^\s*[-*]\s*/u, "")
        .replace(/^["']+/u, "")
        .replace(/^(?:evaluation|validation|test)\s*:\s*/iu, "")
        .replace(/^.*?\b(?:on|using)\s+(?:the\s+)?(?:full\s+)?/iu, "")
        .replace(/^\s*full\s+/iu, "")
        .trim();
      const taskMatch = /^(.+?)(?=\s+(?:multiple[-\s]?choice|labelled|labeled|validation|test|evaluation|full)\b)/iu.exec(prefix);
      const taskKey = taskMatch ? canonicalEvaluationTaskKey(taskMatch[1] || "") : undefined;
      if (taskKey) {
        counts[taskKey] = Math.max(counts[taskKey] || 0, count);
      }
    }
  }
  return counts;
}

function canonicalEvaluationTaskKey(value: string): string | undefined {
  const normalized = value
    .replace(/^["'([{]+|["')\]}:,]+$/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 64);
  if (!normalized || /^(?:benchmark|task|evaluation|validation|test|full)$/u.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function extractTaskEvaluationCount(text: string, taskAliases: string[]): number | undefined {
  const aliasPattern = taskAliases.map((alias) => alias.replace(/[-_]/gu, "[-_\\s]?")).join("|");
  const patterns = [
    new RegExp(`\\b(?:${aliasPattern})\\b[\\s\\S]{0,120}?\\bn\\s*=\\s*(\\d[\\d,]*)\\b`, "iu"),
    new RegExp(`\\b(?:${aliasPattern})\\b[\\s\\S]{0,120}?\\b(\\d[\\d,]*)\\s+(?:validation|evaluation)\\s+examples?\\b`, "iu"),
    new RegExp(`\\b(\\d[\\d,]*)\\s+(?:validation|evaluation)\\s+examples?\\b[\\s\\S]{0,120}?\\b(?:${aliasPattern})\\b`, "iu")
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const parsed = match ? parseGroupedPositiveInteger(match[1] || "") : undefined;
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

function parseGroupedPositiveInteger(value: string): number | undefined {
  const parsed = Number.parseInt(value.replace(/,/gu, ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function extractPrimaryMetricKey(text: string): string | undefined {
  const match = text.match(/\b[a-z][a-z0-9_]*(?:delta_vs_baseline|improvement_over_baseline)\b/iu);
  return match?.[0];
}

async function loadPriorRunFailureConstraints(
  runDir: string,
  currentFeedback?: RunVerifierReport
): Promise<string[]> {
  const text = await safeRead(path.join(runDir, "failure_memory.jsonl"));
  const currentFingerprint = currentFeedback?.summary
    ? buildErrorFingerprint(currentFeedback.summary)
    : undefined;
  const records = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as {
          node_id?: string;
          failure_class?: string;
          error_fingerprint?: string;
          error_message?: string;
          do_not_retry?: boolean;
        }];
      } catch {
        return [];
      }
    })
    .reverse();
  const seen = new Set<string>();
  const constraints: string[] = [];
  for (const record of records) {
    if (
      record.node_id !== "run_experiments" ||
      record.do_not_retry !== true ||
      record.failure_class === "transient" ||
      !record.error_message
    ) {
      continue;
    }
    const fingerprint = record.error_fingerprint || buildErrorFingerprint(record.error_message);
    if (fingerprint === currentFingerprint || seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    constraints.push(trimBlock(record.error_message, 600));
    if (constraints.length >= 4) break;
  }
  return constraints;
}

function compactEstimatorFeasibilityForImplementation(
  gate: PersistedEstimatorFeasibilityGate
) {
  const contract = gate.estimator_contract;
  const report = gate.estimator_report;
  if (!gate.valid || !contract || !report || report.status !== "pass") {
    return undefined;
  }
  return {
    bindings: contract.bindings,
    units: contract.units,
    outcome: contract.outcome,
    estimand: contract.estimand,
    estimator: contract.estimator,
    design_matrix: {
      columns: contract.design_matrix.columns,
      cells: contract.design_matrix.cells
    },
    power: contract.power,
    resampling: contract.resampling,
    multiplicity: contract.multiplicity,
    feasibility_metrics: report.metrics,
    contract_content_sha256: contract.content_sha256,
    report_content_sha256: report.content_sha256
  };
}

function compactTaskSpecForStagedLlmPrompt(taskSpec: ImplementTaskSpec): Record<string, unknown> {
  return {
    goal: trimBlock(taskSpec.goal, 160),
    acceptance_criteria: taskSpec.acceptance_criteria.slice(0, 2).map((item) => trimBlock(item, 120)),
    non_goals: taskSpec.non_goals.slice(0, 2).map((item) => trimBlock(item, 100)),
    constraints: taskSpec.constraints.slice(0, 3).map((item) => trimBlock(item, 120)),
    workspace: {
      public_dir: taskSpec.workspace.public_dir,
      metrics_path: taskSpec.workspace.metrics_path
    },
    execution: taskSpec.execution,
    context: {
      topic: trimBlock(taskSpec.context.topic, 160),
      objective_metric: trimBlock(taskSpec.context.objective_metric, 140),
      plan_excerpt: trimBlock(taskSpec.context.plan_excerpt, 600),
      hypotheses_excerpt: trimBlock(taskSpec.context.hypotheses_excerpt, 200),
      previous_summary: trimBlock(taskSpec.context.previous_summary || "", 120) || undefined,
      previous_run_command: trimBlock(taskSpec.context.previous_run_command || "", 120) || undefined,
      previous_script: taskSpec.context.previous_script,
      prior_run_failure_constraints: taskSpec.context.prior_run_failure_constraints
        ?.slice(0, 4)
        .map((item) => trimBlock(item, 320)),
      implementation_contract_feedback: taskSpec.context.implementation_contract_feedback
        ? {
            summary: trimBlock(taskSpec.context.implementation_contract_feedback.summary, 360),
            stderr_excerpt: trimBlock(taskSpec.context.implementation_contract_feedback.stderr_excerpt || "", 360) || undefined,
            blocking_findings: taskSpec.context.implementation_contract_feedback.blocking_findings.slice(0, 6),
            suggested_next_action: trimBlock(
              taskSpec.context.implementation_contract_feedback.suggested_next_action,
              240
            )
          }
        : undefined,
      dependency_repair_context: taskSpec.context.dependency_repair_context,
      comparison_contract: taskSpec.context.comparison_contract
        ? {
            plan_id: taskSpec.context.comparison_contract.plan_id,
            comparison_mode: taskSpec.context.comparison_contract.comparison_mode,
            baseline_first_required: taskSpec.context.comparison_contract.baseline_first_required,
            baseline_candidate_ids: taskSpec.context.comparison_contract.baseline_candidate_ids.slice(0, 2),
            budget_profile: taskSpec.context.comparison_contract.budget_profile,
            evaluator_contract_id: taskSpec.context.comparison_contract.evaluator_contract_id
        }
        : undefined,
      estimator_feasibility: taskSpec.context.estimator_feasibility,
      topic_probe_compute_contract: taskSpec.context.topic_probe_compute_contract,
      planned_condition_contract: taskSpec.context.planned_condition_contract,
      plan_changed: taskSpec.context.plan_changed,
      plan_hash: taskSpec.context.plan_hash
    }
  };
}

function compactTaskSpecForBootstrapPrompt(taskSpec: ImplementTaskSpec): Record<string, unknown> {
  return {
    goal: trimBlock(taskSpec.goal, 120),
    workspace: {
      public_dir: taskSpec.workspace.public_dir,
      metrics_path: taskSpec.workspace.metrics_path
    },
    execution: {
      runner: taskSpec.execution.runner,
      timeout_sec: taskSpec.execution.timeout_sec
    },
    context: {
      topic: trimBlock(taskSpec.context.topic, 120),
      objective_metric: trimBlock(taskSpec.context.objective_metric, 100),
      previous_script: taskSpec.context.previous_script,
      prior_run_failure_constraints: taskSpec.context.prior_run_failure_constraints
        ?.slice(0, 4)
        .map((item) => trimBlock(item, 280)),
      implementation_contract_feedback: taskSpec.context.implementation_contract_feedback
        ? {
            summary: trimBlock(taskSpec.context.implementation_contract_feedback.summary, 240),
            blocking_findings: taskSpec.context.implementation_contract_feedback.blocking_findings.slice(0, 4)
          }
        : undefined,
      dependency_repair_context: taskSpec.context.dependency_repair_context,
      comparison_contract: taskSpec.context.comparison_contract
        ? {
            comparison_mode: taskSpec.context.comparison_contract.comparison_mode,
            baseline_first_required: taskSpec.context.comparison_contract.baseline_first_required,
            budget_profile: taskSpec.context.comparison_contract.budget_profile
        }
        : undefined,
      estimator_feasibility: taskSpec.context.estimator_feasibility,
      planned_condition_contract: taskSpec.context.planned_condition_contract,
      topic_probe_compute_contract: taskSpec.context.topic_probe_compute_contract,
    }
  };
}

function compactTaskSpecForChunkPrompt(taskSpec: ImplementTaskSpec): Record<string, unknown> {
  return {
    goal: trimBlock(taskSpec.goal, 220),
    acceptance_criteria: taskSpec.acceptance_criteria.slice(0, 3).map((item) => trimBlock(item, 140)),
    constraints: taskSpec.constraints.slice(0, 4).map((item) => trimBlock(item, 160)),
    workspace: {
      public_dir: taskSpec.workspace.public_dir,
      metrics_path: taskSpec.workspace.metrics_path
    },
    execution: {
      runner: taskSpec.execution.runner
    },
    context: {
      topic: trimBlock(taskSpec.context.topic, 240),
      objective_metric: trimBlock(taskSpec.context.objective_metric, 180),
      previous_script: taskSpec.context.previous_script,
      previous_run_command: trimBlock(taskSpec.context.previous_run_command || "", 160) || undefined,
      prior_run_failure_constraints: taskSpec.context.prior_run_failure_constraints
        ?.slice(0, 4)
        .map((item) => trimBlock(item, 420)),
      implementation_contract_feedback: taskSpec.context.implementation_contract_feedback
        ? {
            summary: trimBlock(taskSpec.context.implementation_contract_feedback.summary, 320),
            blocking_findings: taskSpec.context.implementation_contract_feedback.blocking_findings.slice(0, 6)
          }
        : undefined,
      dependency_repair_context: taskSpec.context.dependency_repair_context,
      comparison_contract: taskSpec.context.comparison_contract
        ? {
            plan_id: taskSpec.context.comparison_contract.plan_id,
            comparison_mode: taskSpec.context.comparison_contract.comparison_mode,
            baseline_first_required: taskSpec.context.comparison_contract.baseline_first_required,
            budget_profile: taskSpec.context.comparison_contract.budget_profile
        }
        : undefined,
      estimator_feasibility: taskSpec.context.estimator_feasibility,
      planned_condition_contract: taskSpec.context.planned_condition_contract,
      topic_probe_compute_contract: taskSpec.context.topic_probe_compute_contract,
    }
  };
}

function compactImplementationContractFeedbackForStagedLlmPrompt(
  feedback: ImplementationContractFeedback | undefined
): Record<string, unknown> | undefined {
  if (!feedback) {
    return undefined;
  }
  return {
    source: feedback.source,
    stage: feedback.stage,
    summary: trimBlock(feedback.summary, 520),
    stderr_excerpt: trimBlock(feedback.stderr_excerpt || "", 480) || undefined,
    blocking_findings: feedback.blocking_findings.slice(0, 8),
    suggested_next_action: trimBlock(feedback.suggested_next_action, 280)
  };
}

function compactLocalizationForStagedLlmPrompt(localization: LocalizationResult): Record<string, unknown> {
  return {
    summary: trimBlock(localization.summary || "", 120) || undefined,
    strategy: localization.strategy,
    reasoning: trimBlock(localization.reasoning || "", 120) || undefined,
    selected_files: localization.selected_files.slice(0, 3),
    candidate_files: localization.candidates.slice(0, 2).map((candidate) => ({
      path: candidate.path,
      symbol: candidate.symbol,
      confidence: candidate.confidence
    })),
    search_queries: localization.search_queries?.slice(0, 2),
    confidence: localization.confidence
  };
}

function compactBranchPlanForStagedLlmPrompt(branchPlan: BranchPlan): Record<string, unknown> {
  return {
    branch_id: branchPlan.branch_id,
    source: branchPlan.source,
    summary: trimBlock(branchPlan.summary, 120),
    rationale: trimBlock(branchPlan.rationale, 120),
    focus_files: branchPlan.focus_files.slice(0, 2),
    candidate_pool: branchPlan.candidate_pool.slice(0, 2)
  };
}

function compactDecompositionUnitForChunkPrompt(unit: DynamicDecompositionUnit): Record<string, unknown> {
  return {
    id: unit.id,
    unit_type: unit.unit_type,
    title: unit.title,
    purpose: trimBlock(unit.purpose, 260),
    generation_mode: unit.generation_mode,
    target_path: unit.target_path,
    depends_on: unit.depends_on?.slice(0, 4),
    verification_focus: unit.verification_focus?.slice(0, 5)
  };
}

function compactMaterializationPlanForChunkPrompt(plan: DynamicMaterializationPlan): Record<string, unknown> {
  return {
    strategy: plan.strategy,
    rationale: trimBlock(plan.rationale || "", 240) || undefined,
    chunks: plan.chunks.map((chunk) => compactMaterializationChunkForChunkPrompt(chunk))
  };
}

function compactMaterializationChunkForChunkPrompt(chunk: DynamicMaterializationChunk): Record<string, unknown> {
  return {
    id: chunk.id,
    title: chunk.title,
    purpose: trimBlock(chunk.purpose, 220),
    content_kind: chunk.content_kind,
    include_imports: chunk.include_imports === true ? true : undefined,
    include_entrypoint: chunk.include_entrypoint === true ? true : undefined,
    depends_on: chunk.depends_on?.slice(0, 4),
    verification_focus: chunk.verification_focus?.slice(0, 4)
  };
}

function buildMaterializationChunkArtifactId(input: {
  unit: DynamicDecompositionUnit;
  chunk: DynamicMaterializationChunk;
  chunkLabel: string;
  subdivisionDepth: number;
}): string {
  return [
    sanitizeArtifactId(input.unit.id),
    sanitizeArtifactId(input.chunk.id),
    `d${input.subdivisionDepth}`,
    sanitizeArtifactId(input.chunkLabel)
  ].join("__");
}

function buildCompactImplementDecompositionRepairContext(params: {
  taskSpec: ImplementTaskSpec;
  searchLocalization: LocalizationResult;
  branchPlan: BranchPlan;
  scaffold: StructuredImplementResponse;
}): Record<string, unknown> {
  const compactTaskSpec = compactTaskSpecForStagedLlmPrompt(params.taskSpec) as {
    goal?: string;
    context?: {
      topic?: string;
      objective_metric?: string;
    };
  };
  return {
    goal: compactTaskSpec.goal,
    topic: compactTaskSpec.context?.topic,
    objective_metric: compactTaskSpec.context?.objective_metric,
    public_dir: params.taskSpec.workspace.public_dir,
    metrics_path: params.taskSpec.workspace.metrics_path,
    branch: {
      summary: trimBlock(params.branchPlan.summary, 220),
      rationale: trimBlock(params.branchPlan.rationale, 220),
      focus_files: params.branchPlan.focus_files.slice(0, 3)
    },
    localization: {
      selected_files: params.searchLocalization.selected_files.slice(0, 4),
      candidate_files: params.searchLocalization.candidates.slice(0, 4).map((candidate) => ({
        path: candidate.path,
        reason: trimBlock(candidate.reason || "", 140) || undefined,
        confidence: candidate.confidence
      }))
    },
    scaffold: {
      summary: trimBlock(params.scaffold.summary || "", 260) || undefined,
      experiment_mode: params.scaffold.experiment_mode,
      run_command: trimBlock(params.scaffold.run_command || "", 260) || undefined,
      test_command: trimBlock(params.scaffold.test_command || "", 220) || undefined,
      public_dir: params.scaffold.public_dir,
      script_path: params.scaffold.script_path,
      metrics_path: params.scaffold.metrics_path,
      changed_files: (params.scaffold.changed_files || []).slice(0, 6),
      public_artifacts: (params.scaffold.public_artifacts || []).slice(0, 6),
      file_plan: (params.scaffold.file_plan || []).slice(0, 6),
      assumptions: (params.scaffold.assumptions || []).slice(0, 4).map((item) => trimBlock(item, 160))
    }
  };
}

function compactLongTermMemoryForStagedLlmPrompt(snapshot: LongTermMemorySnapshot): LongTermMemorySnapshot {
  return {
    search_queries: snapshot.search_queries.slice(0, 2).map((item) => trimBlock(item, 80)),
    retrieved: snapshot.retrieved.slice(0, 1).map((entry) => ({
      ...entry,
      text: trimBlock(entry.text, 120),
      tags: entry.tags.slice(0, 2)
    })),
    saved: snapshot.saved
      ? {
          ...snapshot.saved,
          text: trimBlock(snapshot.saved.text, 120),
          tags: snapshot.saved.tags.slice(0, 2)
        }
      : undefined
  };
}

function compactRunnerFeedbackForStagedLlmPrompt(
  feedback: RunVerifierReport | undefined
): Record<string, unknown> | undefined {
  if (!feedback) {
    return undefined;
  }
  return {
    source: feedback.source,
    status: feedback.status,
    trigger: feedback.trigger,
    stage: feedback.stage,
    summary: trimBlock(feedback.summary || "", 320) || undefined,
    command: trimBlock(feedback.command || "", 220) || undefined,
    metrics_path: feedback.metrics_path,
    suggested_next_action: trimBlock(feedback.suggested_next_action || "", 220) || undefined,
    failure_code: feedback.failure_code,
    repair_target: feedback.repair_target,
    recommended_backtrack_node: feedback.recommended_backtrack_node,
    upstream_repair_hint: trimBlock(feedback.upstream_repair_hint || "", 240) || undefined,
    operator_action_required: feedback.operator_action_required,
    recorded_at: feedback.recorded_at
  };
}

function compactScaffoldSummaryForBootstrapPrompt(scaffold: StructuredImplementResponse): Record<string, unknown> {
  return {
    summary: trimBlock(scaffold.summary || "", 120) || undefined,
    experiment_mode: scaffold.experiment_mode,
    run_command: trimBlock(scaffold.run_command || "", 160) || undefined,
    test_command: trimBlock(scaffold.test_command || "", 120) || undefined,
    script_path: scaffold.script_path,
    metrics_path: scaffold.metrics_path
  };
}

function compactPaperCritiqueForStagedLlmPrompt(
  critique:
    | {
        overall_decision?: string;
        manuscript_type?: string;
        needs_additional_experiments?: boolean;
        blocking_issue_summaries: string[];
        recommended_fixes: string[];
        summary?: string;
      }
    | undefined
): Record<string, unknown> | undefined {
  if (!critique) {
    return undefined;
  }
  return {
    overall_decision: critique.overall_decision,
    manuscript_type: critique.manuscript_type,
    needs_additional_experiments: critique.needs_additional_experiments,
    blocking_issue_summaries: critique.blocking_issue_summaries.slice(0, 4).map((item) => trimBlock(item, 180)),
    recommended_fixes: critique.recommended_fixes.slice(0, 4).map((item) => trimBlock(item, 180)),
    summary: trimBlock(critique.summary || "", 280) || undefined
  };
}

function compactReflectionsForStagedLlmPrompt(reflections: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return reflections.slice(0, 2).map((item) => ({
    ...item,
    lesson: trimBlock(String(item.lesson || ""), 220),
    next_try_instruction: trimBlock(String(item.next_try_instruction || ""), 220)
  }));
}

function compactStringListForStagedLlmPrompt(values: string[], limit: number): string[] {
  return values.slice(0, limit);
}

function compactPreviousAttemptForStagedLlmPrompt(
  attempt:
    | {
        verify_report: VerifyReport;
        localization: LocalizationResult;
        summary: string;
      }
    | undefined
):
  | {
      verify_report: Record<string, unknown>;
      localization: Record<string, unknown>;
      summary: string;
    }
  | undefined {
  if (!attempt) {
    return undefined;
  }
  return {
    verify_report: {
      status: attempt.verify_report.status,
      failure_type: attempt.verify_report.failure_type,
      next_action: attempt.verify_report.next_action,
      summary: trimBlock(attempt.verify_report.summary || "", 320),
      command: trimBlock(attempt.verify_report.command || "", 220) || undefined,
      stdout_excerpt: trimBlock(attempt.verify_report.stdout_excerpt || "", 240) || undefined,
      stderr_excerpt: trimBlock(attempt.verify_report.stderr_excerpt || "", 240) || undefined
    },
    localization: compactLocalizationForStagedLlmPrompt(attempt.localization),
    summary: trimBlock(attempt.summary, 280)
  };
}

function toSandboxFriendlyWorkspaceRoot(workspaceRoot: string): string {
  return resolveWorkspaceRootAliases(workspaceRoot)[0] || workspaceRoot;
}

function resolveWorkspaceRootAliases(workspaceRoot: string): string[] {
  const aliases = new Set<string>();
  const push = (value: string | undefined) => {
    if (value) {
      aliases.add(value);
    }
  };

  push(preferSandboxAlias(workspaceRoot));
  push(workspaceRoot);

  if (workspaceRoot === "/private/tmp" || workspaceRoot.startsWith("/private/tmp/")) {
    push(workspaceRoot.replace(/^\/private\/tmp(?=\/|$)/u, "/tmp"));
  }
  if (workspaceRoot === "/tmp" || workspaceRoot.startsWith("/tmp/")) {
    push(workspaceRoot.replace(/^\/tmp(?=\/|$)/u, "/private/tmp"));
  }
  if (workspaceRoot === "/private/var/folders" || workspaceRoot.startsWith("/private/var/folders/")) {
    push(workspaceRoot.replace(/^\/private\/var\/folders(?=\/|$)/u, "/var/folders"));
  }
  if (workspaceRoot === "/var/folders" || workspaceRoot.startsWith("/var/folders/")) {
    push(workspaceRoot.replace(/^\/var\/folders(?=\/|$)/u, "/private/var/folders"));
  }

  return [...aliases];
}

function preferSandboxAlias(value: string): string {
  if (value === "/private/tmp" || value.startsWith("/private/tmp/")) {
    return value.replace(/^\/private\/tmp(?=\/|$)/u, "/tmp");
  }
  if (value === "/private/var/folders" || value.startsWith("/private/var/folders/")) {
    return value.replace(/^\/private\/var\/folders(?=\/|$)/u, "/var/folders");
  }
  return value;
}

function rewriteWorkspacePathsForSandbox<T>(value: T, workspaceRoot: string): T {
  if (typeof value === "string") {
    return rewriteWorkspaceStringForSandbox(value, workspaceRoot) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteWorkspacePathsForSandbox(item, workspaceRoot)) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      rewriteWorkspacePathsForSandbox(nested, workspaceRoot)
    ])
  ) as T;
}

function rewriteWorkspaceStringForSandbox(value: string | undefined, workspaceRoot: string): string | undefined {
  if (!value) {
    return value;
  }
  const primary = toSandboxFriendlyWorkspaceRoot(workspaceRoot);
  const aliases = resolveWorkspaceRootAliases(workspaceRoot)
    .filter((alias) => alias !== primary)
    .sort((left, right) => right.length - left.length);

  let rewritten = value;
  for (const alias of aliases) {
    rewritten = rewritten.replaceAll(alias, primary);
  }
  return rewritten;
}

function rewriteWorkspacePathsToPrimary<T>(value: T, workspaceRoot: string): T {
  if (typeof value === "string") {
    return rewriteWorkspaceStringToPrimary(value, workspaceRoot) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteWorkspacePathsToPrimary(item, workspaceRoot)) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      rewriteWorkspacePathsToPrimary(nested, workspaceRoot)
    ])
  ) as T;
}

function rewriteWorkspaceStringToPrimary(value: string | undefined, workspaceRoot: string): string | undefined {
  if (!value) {
    return value;
  }
  const aliases = resolveWorkspaceRootAliases(workspaceRoot)
    .filter((alias) => alias !== workspaceRoot)
    .sort((left, right) => right.length - left.length);

  let rewritten = value;
  for (const alias of aliases) {
    rewritten = replaceWorkspaceRootReference(rewritten, alias, workspaceRoot);
  }
  return rewritten;
}

async function resolveLocalVerificationWorkspaceRoot(workspaceRoot: string): Promise<string> {
  for (const alias of resolveWorkspaceRootAliases(workspaceRoot)) {
    if (await fileExists(alias)) {
      return alias;
    }
  }
  return toSandboxFriendlyWorkspaceRoot(workspaceRoot);
}

function rewriteWorkspacePathsForExecution<T>(
  value: T,
  workspaceRoot: string,
  executionWorkspaceRoot: string
): T {
  if (typeof value === "string") {
    return rewriteWorkspaceStringForExecution(
      value,
      workspaceRoot,
      executionWorkspaceRoot
    ) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      rewriteWorkspacePathsForExecution(item, workspaceRoot, executionWorkspaceRoot)
    ) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      rewriteWorkspacePathsForExecution(nested, workspaceRoot, executionWorkspaceRoot)
    ])
  ) as T;
}

function rewriteWorkspaceStringForExecution(
  value: string | undefined,
  workspaceRoot: string,
  executionWorkspaceRoot: string
): string | undefined {
  if (!value) {
    return value;
  }
  const aliases = resolveWorkspaceRootAliases(workspaceRoot)
    .filter((alias) => alias !== executionWorkspaceRoot)
    .sort((left, right) => right.length - left.length);

  let rewritten = value;
  for (const alias of aliases) {
    rewritten = replaceWorkspaceRootReference(rewritten, alias, executionWorkspaceRoot);
  }
  return rewritten;
}

function replaceWorkspaceRootReference(value: string, fromRoot: string, toRoot: string): string {
  if (!value || fromRoot === toRoot) {
    return value;
  }
  const escaped = escapeRegex(fromRoot);
  const pattern = new RegExp(`(^|[\\s"'=:(\\[{,])${escaped}(?=$|[\\/\\s"'=)\\]};,])`, "g");
  return value.replace(pattern, (_match, prefix: string) => `${prefix}${toRoot}`);
}

function mapAliasedWorkspacePathToPrimary(filePath: string, workspaceRoot: string): string {
  if (!path.isAbsolute(filePath)) {
    return filePath;
  }
  for (const alias of resolveWorkspaceRootAliases(workspaceRoot)) {
    if (!isPathInsideOrEqual(filePath, alias)) {
      continue;
    }
    const relative = path.relative(alias, filePath);
    return relative ? path.join(workspaceRoot, relative) : workspaceRoot;
  }
  return filePath;
}

async function topLevelWorkspaceListing(workspaceRoot: string): Promise<string> {
  try {
    const entries = await fs.readdir(workspaceRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.name !== "node_modules" && entry.name !== ".git")
      .slice(0, 80)
      .map((entry) => `${entry.isDirectory() ? "[dir]" : "[file]"} ${entry.name}`)
      .join("\n");
  } catch {
    return "(unavailable)";
  }
}

async function inferScriptPath(
  runDir: string,
  publicDir: string,
  workspaceRoot: string,
  runCommand?: string
): Promise<string | undefined> {
  const candidates = [
    path.join(publicDir, "experiment.py"),
    path.join(publicDir, "experiment.js"),
    path.join(publicDir, "experiment.sh"),
    path.join(runDir, "experiment.py"),
    path.join(runDir, "experiment.js"),
    path.join(runDir, "experiment.sh")
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  if (runCommand) {
    const token = runCommand
      .split(/\s+/)
      .find((part) => /\.(py|js|sh|mjs|cjs)$/i.test(part.replace(/^['"]|['"]$/g, "")));
    if (token) {
      return normalizeStoredPath(token.replace(/^['"]|['"]$/g, ""), workspaceRoot);
    }
  }

  return undefined;
}

function inferRunCommand(scriptPath: string | undefined, workspaceRoot: string, runId: string): string {
  if (scriptPath) {
    const quoted = JSON.stringify(scriptPath);
    if (/\.py$/i.test(scriptPath)) {
      return `python3 ${quoted}`;
    }
    if (/\.(js|mjs|cjs)$/i.test(scriptPath)) {
      return `node ${quoted}`;
    }
    if (/\.sh$/i.test(scriptPath)) {
      return `bash ${quoted}`;
    }
  }

  const fallback = path.join(workspaceRoot, ".autolabos", "runs", runId, "experiment.py");
  return `python3 ${JSON.stringify(fallback)}`;
}

export function selectRecoveredPublicBundleScriptPath(params: {
  publicDir: string;
  entries: string[];
  runnerFeedback?: RunVerifierReport;
}): string | undefined {
  const candidatePaths = params.entries
    .filter((entry) => /\.(py|js|sh|mjs|cjs)$/iu.test(entry))
    .map((entry) => path.join(params.publicDir, entry));
  if (candidatePaths.length === 0) {
    return undefined;
  }
  const feedbackText = [
    params.runnerFeedback?.command,
    params.runnerFeedback?.summary,
    params.runnerFeedback?.stderr_excerpt,
    params.runnerFeedback?.stdout_excerpt,
    params.runnerFeedback?.suggested_next_action
  ].filter((value): value is string => Boolean(value)).join("\n");
  return prioritizeImplementationContractFocus(candidatePaths, feedbackText)[0];
}

async function inferRecoveredBundleWrapperRunCommand(params: {
  wrapperPath: string;
  scriptPath: string;
}): Promise<string | undefined> {
  if (!(await fileExists(params.wrapperPath))) {
    return undefined;
  }
  const wrapperText = await safeRead(params.wrapperPath);
  if (!wrapperText) {
    return undefined;
  }
  const scriptBase = path.basename(params.scriptPath);
  if (!wrapperText.includes(scriptBase) && !wrapperText.includes(params.scriptPath)) {
    return undefined;
  }
  return `bash ${JSON.stringify(params.wrapperPath)}`;
}

async function recoverStructuredResultFromPublicBundle(params: {
  publicDir: string;
  runDir: string;
  metricsPath: string;
  workspaceRoot: string;
  errorMessage: string;
  materializedAfterMs?: number;
  requireFreshPlanAlignment?: boolean;
  runnerFeedback?: RunVerifierReport;
  runnerFeedbackDiagnosticText?: string;
  plannedConditionContract?: PlannedConditionContract;
}): Promise<RunTurnResult | undefined> {
  if (params.requireFreshPlanAlignment || params.runnerFeedback) {
    return undefined;
  }
  if (!(await hasRecoverableExecutionEvidence(params.publicDir, params.metricsPath))) {
    return undefined;
  }

  const entries = await fs.readdir(params.publicDir).catch(() => []);
  const scriptPath = selectRecoveredPublicBundleScriptPath({
    publicDir: params.publicDir,
    entries
  });
  if (!scriptPath) {
    return undefined;
  }
  if (typeof params.materializedAfterMs === "number" && Number.isFinite(params.materializedAfterMs)) {
    const scriptStats = await fs.stat(scriptPath).catch(() => undefined);
    if (!scriptStats || scriptStats.mtimeMs + 1000 < params.materializedAfterMs) {
      return undefined;
    }
  }
  const scriptContent = await fs.readFile(scriptPath, "utf8").catch(() => "");
  if (!hasSubstantiveMaterializedContent(scriptContent, scriptPath)) {
    return undefined;
  }
  if (await recoveredBundleHasUnfilledAutolabosSections(params.publicDir)) {
    return undefined;
  }

  const readmePath = path.join(params.publicDir, "README.md");
  const frozenConfigPath = path.join(params.publicDir, "frozen_config.json");
  const baselineSummaryPath = path.join(params.publicDir, "baseline_summary.json");
  const experimentPlanPath = path.join(params.publicDir, "experiment_plan.yaml");
  const wrapperPath = path.join(params.publicDir, "run_command.sh");
  const publicArtifacts = await filterExistingFiles([
    scriptPath,
    wrapperPath,
    readmePath,
    frozenConfigPath,
    baselineSummaryPath,
    experimentPlanPath,
    params.metricsPath
  ]);
  if (publicArtifacts.length === 0) {
    return undefined;
  }

  const inferredRunCommand = normalizeRecoveredBundleRunCommand(
    inferRecoveredBundleRunCommand({
      scriptPath,
      frozenConfigPath,
      publicDir: params.publicDir,
      runDir: params.runDir,
      metricsPath: params.metricsPath
    }),
    params.workspaceRoot
  );
  const readmeRunCommand = normalizeRecoveredBundleRunCommand(
    await readRunnableCommandFromReadme(readmePath),
    params.workspaceRoot
  );
  const wrapperRunCommand = normalizeRecoveredBundleRunCommand(
    await inferRecoveredBundleWrapperRunCommand({ wrapperPath, scriptPath }),
    params.workspaceRoot
  );
  const runCommand = readmeRunCommand || wrapperRunCommand || inferredRunCommand;
  if (!runCommand || commandRequestsNonEvidenceRun(runCommand)) {
    return undefined;
  }
  if (!(await recoveredBundleSatisfiesRetryScope({ frozenConfigPath, runCommand }))) {
    return undefined;
  }

  return {
    finalText: JSON.stringify({
      summary: "Recovered an unchanged implementation bundle with existing execution evidence.",
      experiment_mode: "real_execution",
      run_command: runCommand,
      test_command: deriveFallbackTestCommand(scriptPath),
      working_dir: params.publicDir,
      changed_files: [],
      artifacts: publicArtifacts,
      public_dir: params.publicDir,
      public_artifacts: publicArtifacts,
      script_path: scriptPath,
      metrics_path: params.metricsPath,
      localization: {
        summary: "Recovered localization from verified public artifacts.",
        selected_files: publicArtifacts,
        candidate_files: publicArtifacts.map((filePath) => ({
          path: filePath,
          reason: "Existing governed artifact with execution evidence.",
          confidence: 0.7
        }))
      },
      assumptions: [params.errorMessage]
    }),
    events: []
  };
}

async function recoveredBundleHasUnfilledAutolabosSections(bundleDir: string): Promise<boolean> {
  const entries = await fs.readdir(bundleDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".py") {
      continue;
    }
    if (await detectPythonUnfilledAutolabosSections(path.join(bundleDir, entry.name))) {
      return true;
    }
  }
  return false;
}

async function hasRecoverableExecutionEvidence(publicDir: string, metricsPath: string): Promise<boolean> {
  if (await fileExists(metricsPath)) {
    return true;
  }
  const artifactsDir = path.join(publicDir, "artifacts");
  try {
    const stack = [artifactsDir];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) {
        continue;
      }
      const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isFile()) {
          return true;
        }
        if (entry.isDirectory()) {
          stack.push(fullPath);
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function readRunnableCommandFromReadme(readmePath: string): Promise<string | undefined> {
  if (!(await fileExists(readmePath))) {
    return undefined;
  }
  const content = await fs.readFile(readmePath, "utf8").catch(() => "");
  if (!content) {
    return undefined;
  }
  const matches = [...content.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/gu)];
  if (matches.length === 0) {
    return undefined;
  }
  const commands = matches
    .map((match) => collapseRunnableCommandBlock(match[1]))
    .filter((value): value is string => Boolean(value));
  if (commands.length === 0) {
    return undefined;
  }
  return (
    commands.find((command) => command.includes("--metrics-path") && !commandRequestsDryRun(command)) ||
    commands.find((command) => !commandRequestsDryRun(command)) ||
    commands[0]
  );
}

function collapseRunnableCommandBlock(block: string | undefined): string | undefined {
  if (!block) {
    return undefined;
  }
  const collapsed = block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s*\\\s*/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return collapsed || undefined;
}

function normalizeRecoveredBundleRunCommand(
  command: string | undefined,
  workspaceRoot: string
): string | undefined {
  if (!command) {
    return undefined;
  }
  let tokenIndex = 0;
  return command.replace(/"[^"]+"|'[^']+'|\S+/g, (rawToken) => {
    const token = unquoteShellToken(rawToken);
    const currentIndex = tokenIndex;
    tokenIndex += 1;
    if (currentIndex === 0 || token.startsWith("-") || !looksLikeWorkspacePathToken(token)) {
      return rawToken;
    }
    return JSON.stringify(path.resolve(workspaceRoot, token));
  });
}

function looksLikeWorkspacePathToken(token: string): boolean {
  if (!token || path.isAbsolute(token)) {
    return false;
  }
  return (
    token.startsWith("./") ||
    token.startsWith("../") ||
    token.startsWith(".autolabos/") ||
    token.startsWith("outputs/") ||
    /\.(py|js|sh|mjs|cjs|json|ya?ml)$/i.test(token)
  );
}

function unquoteShellToken(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

function inferRecoveredBundleRunCommand(params: {
  scriptPath: string;
  frozenConfigPath: string;
  publicDir: string;
  runDir: string;
  metricsPath: string;
}): string {
  if (/\.py$/i.test(params.scriptPath)) {
    const segments = [`python3 ${JSON.stringify(params.scriptPath)}`];
    if (path.basename(params.frozenConfigPath) && params.frozenConfigPath !== params.scriptPath) {
      segments.push(`--config ${JSON.stringify(params.frozenConfigPath)}`);
    }
    segments.push(`--public-dir ${JSON.stringify(params.publicDir)}`);
    segments.push(`--run-dir ${JSON.stringify(params.runDir)}`);
    segments.push(`--metrics-path ${JSON.stringify(params.metricsPath)}`);
    return segments.join(" ");
  }
  return inferRunCommand(params.scriptPath, params.publicDir, path.basename(params.runDir));
}

async function recoveredBundleSatisfiesRetryScope(args: {
  frozenConfigPath: string;
  runCommand: string;
}): Promise<boolean> {
  const config = parseJsonObject(await fs.readFile(args.frozenConfigPath, "utf8").catch(() => ""));
  if (!config || typeof config !== "object") {
    return true;
  }
  const record = config as Record<string, unknown>;
  const split = record.split && typeof record.split === "object" ? (record.split as Record<string, unknown>) : undefined;
  const repeats = record.repeats && typeof record.repeats === "object" ? (record.repeats as Record<string, unknown>) : undefined;
  const negativeControl =
    record.negative_control && typeof record.negative_control === "object"
      ? (record.negative_control as Record<string, unknown>)
      : undefined;
  const previousScope =
    negativeControl?.previous_scope && typeof negativeControl.previous_scope === "object"
      ? (negativeControl.previous_scope as Record<string, unknown>)
      : undefined;

  const previousPilotSize =
    asFiniteNumber(previousScope?.pilot_size) ?? asFiniteNumber(split?.previous_local_pilot_size);
  const previousRepeats = asFiniteNumber(previousScope?.repeats);
  if (previousPilotSize === undefined && previousRepeats === undefined) {
    return true;
  }

  const nextPilotSize =
    extractNumericFlag(args.runCommand, "--pilot-size") ?? asFiniteNumber(split?.default_local_pilot_size);
  const nextRepeats =
    extractNumericFlag(args.runCommand, "--repeats") ?? asFiniteNumber(repeats?.default_local_repeats);

  if (previousPilotSize !== undefined && nextPilotSize !== undefined && nextPilotSize > previousPilotSize) {
    return true;
  }
  if (previousRepeats !== undefined && nextRepeats !== undefined && nextRepeats > previousRepeats) {
    return true;
  }
  if (previousPilotSize === undefined && previousRepeats !== undefined && nextRepeats === undefined) {
    return false;
  }
  if (previousRepeats === undefined && previousPilotSize !== undefined && nextPilotSize === undefined) {
    return false;
  }
  return previousPilotSize === undefined && previousRepeats === undefined;
}

function extractNumericFlag(command: string, flag: string): number | undefined {
  const escapedFlag = escapeRegex(flag);
  const pattern = new RegExp(`${escapedFlag}\\s+(?:"([^"]+)"|'([^']+)'|(\\S+))`, "u");
  const match = command.match(pattern);
  if (!match) {
    return undefined;
  }
  return asFiniteNumber(match[1] || match[2] || match[3]);
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function commandRequestsDryRun(command: string | undefined): boolean {
  if (!command) {
    return false;
  }
  return /(^|\s)--dry-run(?=\s|$)/u.test(command);
}

function commandRequestsNonEvidenceRun(command: string | undefined): boolean {
  if (!command) {
    return false;
  }
  return /(^|\s)--(?:dry-run|smoke|smoke-test|simulate|simulation-only|force-synthetic)(?=\s|$)/u.test(command);
}

const DEFAULT_IMPLEMENT_LLM_TIMEOUT_MS = 1_800_000;
const DEFAULT_IMPLEMENT_LLM_PROGRESS_STALL_TIMEOUT_MS = 300_000;

export function getImplementLlmTimeoutMs(config: AppConfig): number {
  const raw = process.env.AUTOLABOS_IMPLEMENT_LLM_TIMEOUT_MS?.trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  void config;
  return DEFAULT_IMPLEMENT_LLM_TIMEOUT_MS;
}

export function getImplementLlmProgressStallTimeoutMs(): number {
  const raw = process.env.AUTOLABOS_IMPLEMENT_LLM_PROGRESS_STALL_TIMEOUT_MS?.trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return DEFAULT_IMPLEMENT_LLM_PROGRESS_STALL_TIMEOUT_MS;
}

export function shouldRequireFreshRecoveredBundlePlanAlignment(params: {
  planChanged: boolean;
  hasImplementationContractFeedback?: boolean;
  hasRunnerFeedback: boolean;
  hasPaperCritiqueFeedback: boolean;
  commandRepairFeedback: boolean;
}): boolean {
  if (params.planChanged) {
    return true;
  }
  if (params.commandRepairFeedback) {
    return false;
  }
  if (params.hasImplementationContractFeedback) {
    return true;
  }
  return params.hasRunnerFeedback || params.hasPaperCritiqueFeedback;
}

function normalizeExperimentMode(mode: string | undefined, summary: string | undefined): string {
  const normalized = (mode || "").trim().toLowerCase();
  if (normalized === "real_execution" || normalized === "hybrid_validation" || normalized === "synthetic_validation") {
    return normalized;
  }
  const lowerSummary = (summary || "").toLowerCase();
  if (/(synthetic|simulate|simulated|deterministic metrics)/u.test(lowerSummary)) {
    return "synthetic_validation";
  }
  if (/(hybrid|mixed)/u.test(lowerSummary)) {
    return "hybrid_validation";
  }
  return "real_execution";
}

function formatImplementSummary(summary: string, experimentMode: string, verifyReport?: VerifyReport): string {
  const trimmed = summary.trim();
  let base = trimmed;
  if (!trimmed) {
    base = experimentMode === "synthetic_validation"
      ? "Implemented a synthetic validation experiment."
      : "Implemented a runnable experiment.";
  } else if (trimmed.toLowerCase().includes(experimentMode.replace(/_/g, " "))) {
    base = trimmed;
  } else if (experimentMode === "synthetic_validation") {
    base = `Synthetic validation: ${trimmed}`;
  } else if (experimentMode === "hybrid_validation") {
    base = `Hybrid validation: ${trimmed}`;
  }

  if (!verifyReport) {
    return base;
  }

  if (verifyReport.status === "pass" && verifyReport.command) {
    return `${base} Verified locally with ${verifyReport.command}.`;
  }
  if (verifyReport.status === "not_run") {
    return `${base} Local verification deferred to run_experiments.`;
  }
  return `${base} Local verification failed: ${verifyReport.summary}`;
}

export function alignImplementSummaryWithPlannedConditionContract(
  summary: string,
  contract?: {
    required_condition_count?: number;
    required_run_count?: number;
    seed_schedule?: number[];
    minimum_seeds_per_condition?: number;
  }
): string {
  const trimmed = summary.trim();
  const requiredConditionCount = normalizeContractPositiveInteger(contract?.required_condition_count);
  const requiredRunCount = normalizeContractPositiveInteger(contract?.required_run_count);
  const scheduledSeedCount = (contract?.seed_schedule || []).filter((seed) => Number.isInteger(Number(seed))).length;
  const seedCount = normalizeContractPositiveInteger(contract?.minimum_seeds_per_condition)
    ?? (scheduledSeedCount > 0 ? scheduledSeedCount : undefined);
  if (requiredConditionCount === undefined && requiredRunCount === undefined && seedCount === undefined) {
    return trimmed;
  }

  const conflicts = [
    requiredConditionCount !== undefined && summaryHasConflictingCount(
      trimmed,
      /\b(\d+)\s+(?:approved\s+|planned\s+|required\s+|tuned\s+)?conditions?\b/giu,
      requiredConditionCount
    ),
    requiredRunCount !== undefined && summaryHasConflictingCount(
      trimmed,
      /\b(\d+)\s+(?:approved\s+|planned\s+|required\s+|total\s+)?runs?\b/giu,
      requiredRunCount
    ),
    seedCount !== undefined && summaryHasConflictingCount(
      trimmed,
      /\b(\d+)\s+(?:approved\s+|planned\s+|required\s+)?seeds?(?:\s+per\s+condition)?\b/giu,
      seedCount
    )
  ].some(Boolean);

  const contractSummary = formatPlannedConditionContractSummary({
    requiredConditionCount,
    requiredRunCount,
    seedCount
  });
  if (!contractSummary) {
    return trimmed;
  }
  if (!trimmed || conflicts) {
    return `Implemented a runnable experiment scaffold for the approved design contract: ${contractSummary}.`;
  }
  if (trimmed.includes(contractSummary)) {
    return trimmed;
  }
  return `${trimmed} Approved design contract: ${contractSummary}.`;
}

function summaryHasConflictingCount(summary: string, pattern: RegExp, expected: number): boolean {
  for (const match of summary.matchAll(pattern)) {
    const observed = Number(match[1]);
    if (Number.isFinite(observed) && observed !== expected) {
      return true;
    }
  }
  return false;
}

function formatPlannedConditionContractSummary(input: {
  requiredConditionCount?: number;
  requiredRunCount?: number;
  seedCount?: number;
}): string {
  const parts = [
    input.requiredConditionCount !== undefined ? `${input.requiredConditionCount} condition(s)` : undefined,
    input.seedCount !== undefined ? `${input.seedCount} seed(s) per condition` : undefined,
    input.requiredRunCount !== undefined ? `${input.requiredRunCount} required run(s)` : undefined
  ].filter((part): part is string => Boolean(part));
  return parts.join(", ");
}

function rewriteCommandScriptPath(
  command: string,
  originalScriptPath: string | undefined,
  publishedScriptPath: string | undefined
): string {
  if (!command || !originalScriptPath || !publishedScriptPath || originalScriptPath === publishedScriptPath) {
    return command;
  }
  const replacements: Array<[string, string]> = [
    [JSON.stringify(originalScriptPath), JSON.stringify(publishedScriptPath)],
    [`'${originalScriptPath}'`, `'${publishedScriptPath}'`],
    [originalScriptPath, publishedScriptPath]
  ];
  let rewritten = command;
  for (const [from, to] of replacements) {
    rewritten = rewritten.split(from).join(to);
  }
  return rewritten;
}

function alignLightweightSyntaxCheckToScriptPath(params: {
  command: string | undefined;
  scriptPath: string | undefined;
  workingDir: string;
  workspaceRoot: string;
}): string | undefined {
  const command = params.command?.trim();
  if (!command || !params.scriptPath || !/\bpy_compile\b/u.test(command)) {
    return command || undefined;
  }
  const referencedScripts = extractWorkspacePathsFromCommand(command, params.workingDir, params.workspaceRoot)
    .filter((candidate) => /\.py$/iu.test(candidate));
  if (referencedScripts.length !== 1 || path.normalize(referencedScripts[0]) === path.normalize(params.scriptPath)) {
    return command;
  }
  return deriveFallbackTestCommand(params.scriptPath) || command;
}

function shouldTrackPatchEvent(payload: Record<string, unknown>): boolean {
  const sourceEvent = typeof payload.source_event === "string" ? payload.source_event.toLowerCase() : "";
  if (!sourceEvent) {
    return false;
  }
  if (sourceEvent === "item.completed" || sourceEvent === "message.completed" || sourceEvent.endsWith(".completed")) {
    return false;
  }
  return (
    sourceEvent.includes("patch") ||
    sourceEvent.includes("file.changed") ||
    sourceEvent.includes("write") ||
    sourceEvent.includes("edit")
  );
}

async function materializeDeclaredArtifacts(params: {
  changedFiles: string[];
  artifacts: string[];
  explicitPublicArtifacts: string[];
  runDir: string;
  publicDir: string;
  scriptPath?: string;
}): Promise<{
  changedFiles: string[];
  artifacts: string[];
  publicArtifacts: string[];
  missingArtifacts: string[];
  scriptPath?: string;
}> {
  const publishedArtifacts = await publishReusableArtifacts({
    changedFiles: params.changedFiles,
    artifacts: params.artifacts,
    explicitPublicArtifacts: params.explicitPublicArtifacts,
    runDir: params.runDir,
    publicDir: params.publicDir
  });
  const publicArtifactCandidates = dedupeStrings([
    ...params.explicitPublicArtifacts,
    ...params.changedFiles.filter((filePath) => isPathInsideOrEqual(filePath, params.publicDir)),
    ...params.artifacts.filter((filePath) => isPathInsideOrEqual(filePath, params.publicDir)),
    ...publishedArtifacts
  ]);
  let scriptPath = params.scriptPath;
  if (scriptPath && isSubpath(scriptPath, params.runDir)) {
    const candidate = path.join(params.publicDir, path.relative(params.runDir, scriptPath));
    if (await fileExists(candidate)) {
      scriptPath = candidate;
      publicArtifactCandidates.push(candidate);
    }
  }
  if (scriptPath && isPathInsideOrEqual(scriptPath, params.publicDir)) {
    publicArtifactCandidates.push(scriptPath);
  }

  const existingChangedFiles = await filterExistingFiles([
    ...params.changedFiles,
    ...publishedArtifacts
  ]);
  const existingArtifacts = await filterExistingFiles([
    ...params.artifacts,
    ...publishedArtifacts,
    ...(scriptPath ? [scriptPath] : [])
  ]);
  const existingPublicArtifacts = await filterExistingFiles(publicArtifactCandidates);
  const missingArtifacts = await filterMissingFiles(
    dedupeStrings([
      ...params.artifacts,
      ...params.explicitPublicArtifacts,
      ...(params.scriptPath ? [params.scriptPath] : [])
    ]).filter((filePath) => !isDeferredExecutionArtifact(filePath, params.runDir))
  );
  const existingScriptPath =
    scriptPath && (await fileExists(scriptPath))
      ? scriptPath
      : inferRunnableScriptFromArtifacts(existingPublicArtifacts, existingArtifacts);

  return {
    changedFiles: existingChangedFiles,
    artifacts: existingArtifacts,
    publicArtifacts: existingPublicArtifacts,
    missingArtifacts,
    scriptPath: existingScriptPath
  };
}

function inferRunnableScriptFromArtifacts(publicArtifacts: string[], artifacts: string[]): string | undefined {
  const candidates = dedupeStrings([...publicArtifacts, ...artifacts]).filter(isRunnableScriptPath);
  return (
    candidates.find((filePath) => path.basename(filePath).toLowerCase() === "experiment.py") ||
    candidates.find((filePath) => /^run[_-].+\.(py|js|sh|mjs|cjs)$/iu.test(path.basename(filePath))) ||
    candidates.find((filePath) => /(?:^|[_-])experiment\.(py|js|sh|mjs|cjs)$/iu.test(path.basename(filePath))) ||
    candidates[0]
  );
}

function isRunnableScriptPath(filePath: string): boolean {
  return /\.(py|js|sh|mjs|cjs)$/iu.test(filePath);
}

function isDeferredExecutionArtifact(filePath: string, runDir: string): boolean {
  if (isPathInsideOrEqual(filePath, runDir)) {
    return isDeferredExecutionArtifactPath(filePath);
  }
  return isDeferredExecutionArtifactPath(filePath);
}

function isDeferredExecutionArtifactPath(filePath: string): boolean {
  const normalizedPath = path.normalize(filePath);
  const base = path.basename(filePath).toLowerCase();
  if (normalizedPath.includes(`${path.sep}.autolabos${path.sep}runs${path.sep}`)) {
    return isDeferredExecutionArtifactBaseName(base);
  }
  const segments = normalizedPath.split(path.sep).filter(Boolean);
  const outputsIndex = segments.indexOf("outputs");
  if (outputsIndex === -1) {
    return false;
  }
  const tail = segments.slice(outputsIndex + 2);
  if (tail.length >= 2 && tail[0] === "results") {
    return true;
  }
  if (tail.length >= 3 && tail[0] === "experiment" && tail[1] === "results") {
    return true;
  }
  if (tail.length >= 2 && tail[0] === "experiment" && isDeferredExecutionArtifactBaseName(base)) {
    return true;
  }
  return false;
}

function isDeferredExecutionArtifactBaseName(base: string): boolean {
  return (
    /^metrics(?:\.|$)/u.test(base) ||
    /^results(?:\.|$)/u.test(base) ||
    /^result(?:\.|$)/u.test(base) ||
    /(?:^|[_-])metrics?\.json$/u.test(base) ||
    /(?:^|[_-])results?\.json$/u.test(base) ||
    base === "study_results.json" ||
    base === "latest_results.json" ||
    base === "run.log" ||
    base === "objective_evaluation.json" ||
    base === "recent_paper_reproducibility.json"
  );
}

function shouldFallbackToStagedImplementLlm(finalText: string): boolean {
  const normalized = finalText.toLowerCase();
  return (
    normalized.includes("bwrap: loopback: failed rtm_newaddr: operation not permitted") ||
    normalized.includes("codex local filesystem action") ||
    normalized.includes("sandbox startup failure")
  );
}

function shouldDecomposeStagedImplementLlm(config: AppConfig): boolean {
  return config.providers.llm_mode === "codex" || config.providers.llm_mode === "codex_chatgpt_only";
}

function appendStagedImplementScaffoldOverrideToPrompt(prompt: string): string {
  return [
    prompt,
    "",
    "Staged implement scaffold mode:",
    "- Return scaffold metadata first. Do NOT include file_edits or file contents in this response.",
    "- Return ONLY one JSON object with keys: summary, experiment_mode, run_command, test_command, requested_gpu_count, working_dir, changed_files, artifacts, public_dir, public_artifacts, script_path, metrics_path, localization, assumptions, decomposition_plan.",
    "- For experiment_mode=real_execution, the scaffold must route primary metrics only through executed train/evaluate work. Do not plan deterministic, simulated, smoke, cached, or fallback corpora as success-producing primary evidence.",
    "- If a fallback or smoke path is needed, keep it diagnostic-only: it must emit success=false or a failed/blocked status, and it must not populate completed_run_count, completed_condition_count, baseline deltas, or primary metric fields as if real execution occurred.",
    "- changed_files, artifacts, and public_artifacts must list only files materialized during implement_experiments, not deferred runtime outputs such as metrics_path, results*.json, *_results.json, study_results.json, latest_results.json, or run.log.",
    "- decomposition_plan is required and must be compact: include only the smallest materialize_text_file units needed for the runnable bundle, with target_path values matching script_path or changed_files.",
    "- Do NOT include file_edits, file_plan, or file contents in this first scaffold response.",
    "- Keep the scaffold minimal, concrete, and runnable."
  ].join("\n");
}

function appendStagedImplementFileOverrideToPrompt(prompt: string, targetPath: string): string {
  return [
    prompt,
    "",
    "Staged implement file materialization mode:",
    `- You are materializing exactly one text file: ${targetPath}`,
    "- Return ONLY one JSON object with keys: path, content.",
    "- For real_execution bundles, materialize real train/evaluate execution as the only success path for primary metrics. Do not make deterministic, simulated, smoke, cached, or fallback data write completed/success metrics.",
    "- Diagnostic fallback code is allowed only when it writes success=false or failed/blocked metrics and cannot satisfy completed run/condition counts, baseline deltas, or primary metric fields.",
    "- Do NOT repeat the full experiment summary or any extra prose.",
    "- Emit full UTF-8 file content for the requested path."
  ].join("\n");
}

function appendStagedImplementBootstrapContractOverrideToPrompt(prompt: string): string {
  return [
    prompt,
    "",
    "Staged implement bootstrap contract mode:",
    "- Return ONLY one bare JSON object with keys: version, strategy, summary, requires_network, requires_warm_cache, can_execute_under_current_policy, blocking_reason, remediation, requirements, checks.",
    "- Do NOT use markdown fences. Do NOT add prose before or after the JSON.",
    "- This is a pre-code-generation environment/bootstrap contract, not a code scaffold.",
    "- Be explicit about remote assets, Hugging Face dependencies, local cache expectations, and command/module prerequisites.",
    "- Do not add local_path requirements or path_exists checks for artifacts the implementation is expected to create in the public experiment directory, including baseline/result manifests, metrics summaries, generated scripts, result tables, or run outputs.",
    "- If dependency_repair_context is present, explicitly encode the prewarm, available-substitute, or dependency-blocked decision in requirements, remediation, and blocking_reason.",
    "- If there is no concrete non-network blocker, set blocking_reason to an empty string; do not put conditional network/cache warnings in blocking_reason."
  ].join("\n");
}

function appendStagedImplementMaterializationPlanOverrideToPrompt(targetPath: string): string {
  return [
    "You are in staged implement materialization planning mode.",
    `The requested file is: ${targetPath}`,
    "- Return ONLY one bare JSON object with keys: strategy, rationale, chunks.",
    "- Do NOT use markdown fences or any extra commentary.",
    "- Keep chunk scopes non-overlapping and ordered.",
    "- For runnable Python scripts, experiment runners, or CLI entrypoints, use focused chunks unless the file is clearly tiny; do not plan a single giant runner chunk.",
    `- For Python code_section chunks, target at most ${IMPLEMENT_STAGED_LLM_CHUNK_TARGET_CHARS} characters of materialized content; when uncertain, split into more chunks instead of broad helper groups.`,
    "- Separate dataset/corpus loading, tokenization, model loading, one-run execution, raw evidence persistence, metric aggregation, and entrypoint wiring into distinct chunks when any of those concerns appear.",
    "- Let the chunk count follow the requested file's purpose and verification focus while keeping each chunk small enough for bounded generation and validation."
  ].join("\n");
}

function appendStagedImplementChunkOverrideToPrompt(prompt: string, targetPath: string, chunkId: string): string {
  return [
    prompt,
    "",
    "Staged implement chunk materialization mode:",
    `- You are generating only chunk ${chunkId} for ${targetPath}`,
    "- Return ONLY one JSON object with keys: chunk_id, content.",
    "- chunk_id must exactly match the requested chunk id.",
    "- Do not repeat content from earlier chunks.",
    "- Emit only raw UTF-8 code/text for this chunk.",
    "- For Python chunks, ensure the chunk can be inserted into the sectioned file without syntax errors; balance every bracket, parenthesis, quote, and indexing expression locally.",
    "- For Python chunks, do not emit `from __future__ import annotations`; future imports are only valid at the beginning of a module and chunk insertion may place this content later."
  ].join("\n");
}

function appendStagedImplementDecompositionOverrideToPrompt(prompt: string): string {
  return [
    prompt,
    "",
    "Staged implement decomposition repair mode:",
    "- The scaffold already exists but omitted decomposition_plan.",
    "- Return ONLY one bare JSON object with keys: objective, strategy, rationale, units.",
    "- Do NOT use markdown fences. Do NOT add any explanation before or after the JSON.",
    "- The decomposition must be research-purpose-aligned and dynamic, not a fixed ML template.",
    "- Each unit must include: id, unit_type, title, purpose, generation_mode, target_path (if materialized), depends_on, verification_focus.",
    "- Use generation_mode=materialize_text_file only for text artifacts AutoLabOS must materialize now.",
    "- Return only the smallest set of units the current research bundle truly needs."
  ].join("\n");
}

function appendStagedImplementMaterializableUnitRepairOverrideToPrompt(prompt: string): string {
  return [
    prompt,
    "",
    "Staged implement decomposition repair mode for materializable units:",
    "- The previous decomposition plan was parseable but omitted all materializable text units.",
    "- Return ONLY one bare JSON object with keys: objective, strategy, rationale, units.",
    "- Do NOT use markdown fences. Do NOT add any explanation before or after the JSON.",
    "- You MUST include at least one unit with generation_mode=materialize_text_file.",
    "- Prefer the scaffold's script_path, changed_files, and file_plan paths when choosing target_path values.",
    "- Return only the smallest set of materialized text units needed to make the experiment bundle runnable."
  ].join("\n");
}

function appendFilesystemFallbackOverrideToPrompt(prompt: string): string {
  return [
    prompt,
    "",
    "Filesystem-blocker recovery mode:",
    "- A previous Codex workspace filesystem/tooling blocker has already been detected and handled by AutoLabOS.",
    "- Do NOT repeat the blocker narrative, sandbox failure explanation, or any request to retry Codex filesystem actions.",
    "- In this staged_llm mode, you must synthesize the implementation directly as structured file_edits.",
    "- A valid response must include file_edits for each created or modified text artifact needed for the runnable experiment bundle.",
    "- At minimum, emit file_edits for the runnable script and any required config or README referenced by your commands.",
    "- If prior attempts failed before materializing files, treat that as resolved context rather than the answer.",
    "- If inspection is incomplete, generate the smallest bounded implementation that satisfies the task spec, localization hints, and verification command."
  ].join("\n");
}

function isMaterializableImplementTextPath(filePath: string): boolean {
  if (!filePath || isDeferredExecutionArtifactPath(filePath)) {
    return false;
  }
  const ext = path.extname(filePath).toLowerCase();
  if (!ext) {
    return false;
  }
  return [
    ".py",
    ".json",
    ".md",
    ".txt",
    ".yaml",
    ".yml",
    ".toml",
    ".ini",
    ".cfg",
    ".sh",
    ".csv",
    ".tsv"
  ].includes(ext);
}

async function publishReusableArtifacts(params: {
  changedFiles: string[];
  artifacts: string[];
  explicitPublicArtifacts: string[];
  runDir: string;
  publicDir: string;
}): Promise<string[]> {
  await ensureDir(params.publicDir);
  const candidates = new Set<string>([...params.changedFiles, ...params.artifacts, ...params.explicitPublicArtifacts]);
  const published = new Set<string>();
  for (const sourcePath of candidates) {
    if (!sourcePath) {
      continue;
    }
    if (isSubpath(sourcePath, params.publicDir)) {
      published.add(sourcePath);
      continue;
    }
    if (!isSubpath(sourcePath, params.runDir) || !isReusablePublicArtifact(sourcePath)) {
      continue;
    }
    if (!(await fileExists(sourcePath))) {
      continue;
    }
    const destinationPath = path.join(params.publicDir, path.relative(params.runDir, sourcePath));
    await ensureDir(path.dirname(destinationPath));
    await fs.copyFile(sourcePath, destinationPath);
    published.add(destinationPath);
  }
  return [...published];
}

function isReusablePublicArtifact(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (
    /^metrics(?:\.|$)/u.test(base) ||
    /^results(?:\.|$)/u.test(base) ||
    base === "implement_result.json" ||
    base === "objective_evaluation.json" ||
    base === "recent_paper_reproducibility.json"
  ) {
    return false;
  }
  const ext = path.extname(base);
  return [
    ".py",
    ".js",
    ".mjs",
    ".cjs",
    ".sh",
    ".md",
    ".txt",
    ".yaml",
    ".yml",
    ".json",
    ".toml",
    ".cfg",
    ".ini"
  ].includes(ext);
}

async function filterExistingFiles(filePaths: string[]): Promise<string[]> {
  const existing: string[] = [];
  for (const filePath of dedupeStrings(filePaths)) {
    if (filePath && (await fileExists(filePath))) {
      existing.push(filePath);
    }
  }
  return existing;
}

async function filterMissingFiles(filePaths: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const filePath of dedupeStrings(filePaths)) {
    if (filePath && !(await fileExists(filePath))) {
      missing.push(filePath);
    }
  }
  return missing;
}

const ATTEMPT_SNAPSHOT_IGNORED_DIR_NAMES = new Set([
  ".cache",
  ".git",
  ".hf_cache",
  ".mypy_cache",
  ".pytest_cache",
  "__pycache__",
  "artifacts",
  "cache",
  "checkpoints",
  "condition_artifacts",
  "condition_outputs",
  "condition_runs",
  "conditions",
  "evaluation_artifacts",
  "evaluations",
  "hf_home",
  "hf_cache",
  "logs",
  "model_artifacts",
  "node_modules",
  "page_images",
  "pdfs",
  "planned_runs",
  "results",
  "run_artifacts",
  "scratch",
  "study_outputs",
  "study_runs",
  "tokenizer",
  "training_artifacts",
  "training_outputs",
  "training_runs"
]);

const ATTEMPT_SNAPSHOT_IGNORED_FILE_EXTENSIONS = new Set([
  ".bin",
  ".ckpt",
  ".gguf",
  ".onnx",
  ".pt",
  ".pth",
  ".safetensors"
]);

export function shouldSkipAttemptSnapshotPath(filePath: string): boolean {
  if (ATTEMPT_SNAPSHOT_IGNORED_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return true;
  }
  const segments = filePath.split(/[\\/]+/u).filter(Boolean).map((segment) => segment.toLowerCase());
  return segments.some((segment, index) => {
    if (/^seed[_-]?\d+$/u.test(segment)) {
      return true;
    }
    if (ATTEMPT_SNAPSHOT_IGNORED_DIR_NAMES.has(segment)) {
      return true;
    }
    if (segment.startsWith("models--")) {
      return true;
    }
    if (segment.startsWith("datasets--")) {
      return true;
    }
    return segment === "transformers" && index > 0 && segments[index - 1] === "cache";
  });
}

function collectWorkspaceChangedFiles(params: {
  changedFiles: string[];
  workspaceRoot: string;
  publicDir: string;
}): string[] {
  const privateDir = path.join(params.workspaceRoot, ".autolabos");
  const outputsDir = path.join(params.workspaceRoot, "outputs");
  return [...new Set(params.changedFiles.map((filePath) => normalizeStoredPath(filePath, params.workspaceRoot)))]
    .filter((filePath): filePath is string => Boolean(filePath))
    .filter((filePath) => isPathInsideOrEqual(filePath, params.workspaceRoot))
    .filter((filePath) => !isPathInsideOrEqual(filePath, privateDir))
    .filter((filePath) => !isPathInsideOrEqual(filePath, outputsDir))
    .filter((filePath) => !isPathInsideOrEqual(filePath, params.publicDir))
    .map((filePath) => path.relative(params.workspaceRoot, filePath).replace(/\\/g, "/"))
    .sort();
}

async function createImplementAttemptSnapshot(params: {
  workspaceRoot: string;
  runDir: string;
  attempt: number;
}): Promise<ImplementAttemptSnapshot> {
  const snapshotRoot = path.join(
    params.runDir,
    "implement_experiments",
    "attempt_snapshots",
    `attempt_${params.attempt}`
  );
  const orphanedResiduePaths: string[] = [];
  try {
    await fs.access(snapshotRoot);
    const preservedSnapshotRoot = path.join(
      path.dirname(snapshotRoot),
      `${path.basename(snapshotRoot)}.orphaned-${Date.now()}`
    );
    await fs.rm(preservedSnapshotRoot, { recursive: true, force: true });
    await fs.rename(snapshotRoot, preservedSnapshotRoot);
    orphanedResiduePaths.push(preservedSnapshotRoot);
  } catch {
    // no prior residue
  }
  await fs.rm(snapshotRoot, { recursive: true, force: true });
  await ensureDir(snapshotRoot);
  const captured = new Map<
    string,
    {
      targetPath: string;
      kind: "file" | "directory" | "missing";
      snapshotPath?: string;
    }
  >();
  const createdPaths = new Set<string>();
  const protectedDir = path.join(params.runDir, "implement_experiments");

  const capturePath = async (filePath: string | undefined) => {
    const normalized = normalizeStoredPath(filePath, params.workspaceRoot);
    if (!normalized || !isPathInsideOrEqual(normalized, params.workspaceRoot)) {
      return;
    }
    if (isPathInsideOrEqual(normalized, protectedDir)) {
      return;
    }
    if (shouldSkipAttemptSnapshotPath(normalized)) {
      return;
    }
    for (const existingPath of [...captured.keys()]) {
      if (existingPath === normalized || isPathInsideOrEqual(normalized, existingPath)) {
        return;
      }
      if (isPathInsideOrEqual(existingPath, normalized)) {
        captured.delete(existingPath);
      }
    }

    const relativeSnapshotPath = path.join("captured", String(captured.size + 1));
    const snapshotPath = path.join(snapshotRoot, relativeSnapshotPath);
    try {
      const stat = await fs.stat(normalized);
      if (stat.isDirectory()) {
        await ensureDir(path.dirname(snapshotPath));
        await fs.cp(normalized, snapshotPath, {
          recursive: true,
          filter: (source) => !shouldSkipAttemptSnapshotPath(source)
        });
        captured.set(normalized, {
          targetPath: normalized,
          kind: "directory",
          snapshotPath
        });
        return;
      }
      if (stat.isFile()) {
        await ensureDir(path.dirname(snapshotPath));
        await fs.copyFile(normalized, snapshotPath);
        captured.set(normalized, {
          targetPath: normalized,
          kind: "file",
          snapshotPath
        });
        return;
      }
    } catch {
      captured.set(normalized, {
        targetPath: normalized,
        kind: "missing"
      });
      return;
    }
  };

  return {
    snapshotRoot,
    orphanedResiduePaths,
    async capturePaths(paths) {
      for (const filePath of dedupeStrings(
        paths.filter((item): item is string => typeof item === "string")
      )) {
        await capturePath(filePath);
      }
    },
    markCreatedPaths(paths) {
      for (const filePath of dedupeStrings(paths.filter((item): item is string => typeof item === "string"))) {
        const normalized = normalizeStoredPath(filePath, params.workspaceRoot);
        if (!normalized || isPathInsideOrEqual(normalized, protectedDir)) {
          continue;
        }
        if (!isPathInsideOrEqual(normalized, params.workspaceRoot)) {
          continue;
        }
        createdPaths.add(normalized);
      }
    },
    async restore() {
      const restoredPaths = [...captured.values()]
        .map((entry) => entry.targetPath)
        .sort((left, right) => right.length - left.length);
      for (const filePath of [...createdPaths].sort((left, right) => right.length - left.length)) {
        if (captured.has(filePath)) {
          continue;
        }
        await fs.rm(filePath, { recursive: true, force: true });
      }
      for (const entry of [...captured.values()].sort((left, right) => right.targetPath.length - left.targetPath.length)) {
        if (entry.kind === "missing") {
          await fs.rm(entry.targetPath, { recursive: true, force: true });
          continue;
        }
        await fs.rm(entry.targetPath, { recursive: true, force: true });
        if (entry.snapshotPath) {
          if (entry.kind === "directory") {
            await ensureDir(path.dirname(entry.targetPath));
            await fs.cp(entry.snapshotPath, entry.targetPath, { recursive: true });
          } else {
            await ensureDir(path.dirname(entry.targetPath));
            await fs.copyFile(entry.snapshotPath, entry.targetPath);
          }
        }
      }
      return {
        restoredPaths
      };
    },
    async cleanup() {
      await fs.rm(snapshotRoot, { recursive: true, force: true });
    }
  };
}

function resolveConfiguredCandidateIsolationStrategy(config: AppConfig): CandidateIsolationStrategy {
  const configured = asString(
    (config as AppConfig & {
      experiments?: AppConfig["experiments"] & {
        candidate_isolation?: unknown;
        candidate_isolation_strategy?: unknown;
      };
    }).experiments?.candidate_isolation
  ) || asString(
    (config as AppConfig & {
      experiments?: AppConfig["experiments"] & {
        candidate_isolation_strategy?: unknown;
      };
    }).experiments?.candidate_isolation_strategy
  );
  const envOverride = process.env.AUTOLABOS_CANDIDATE_ISOLATION_STRATEGY;
  const raw = (envOverride || configured || "").trim().toLowerCase();
  if (raw === "attempt_worktree" || raw === "worktree") {
    return "attempt_worktree";
  }
  return "attempt_snapshot_restore";
}

async function createAttemptIsolationContext(params: {
  config: AppConfig;
  workspaceRoot: string;
  run: RunRecord;
  runDir: string;
  defaultPublicDir: string;
  metricsPath: string;
  attempt: number;
  requestedStrategy: CandidateIsolationStrategy;
}): Promise<AttemptIsolationContext> {
  if (params.requestedStrategy !== "attempt_worktree") {
    const attemptSnapshot = await createImplementAttemptSnapshot({
      workspaceRoot: params.workspaceRoot,
      runDir: params.runDir,
      attempt: params.attempt
    });
    return {
      requestedStrategy: params.requestedStrategy,
      effectiveStrategy: "attempt_snapshot_restore",
      controlWorkspaceRoot: params.workspaceRoot,
      workspaceRoot: params.workspaceRoot,
      runDir: params.runDir,
      publicDir: params.defaultPublicDir,
      metricsPath: params.metricsPath,
      attemptSnapshot,
      orphanedResiduePaths: attemptSnapshot.orphanedResiduePaths
    };
  }

  try {
    const worktreePath = resolveAttemptWorktreePath(params.runDir, params.attempt);
    const orphanedResiduePaths = await cleanupAttemptWorktreeResidue({
      workspaceRoot: params.workspaceRoot,
      worktreeRoot: resolveAttemptWorktreeRoot(params.runDir),
      worktreePath
    });
    await assertAttemptWorktreeReady({
      workspaceRoot: params.workspaceRoot,
      runId: params.run.id
    });
    await ensureDir(path.dirname(worktreePath));
    await execFile("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], {
      cwd: params.workspaceRoot
    });
    const worktreeRunDir = path.join(worktreePath, ".autolabos", "runs", params.run.id);
    const worktreePublicDir = buildPublicExperimentDir(worktreePath, params.run);
    const worktreeMetricsPath = path.join(worktreeRunDir, "metrics.json");
    await ensureDir(worktreeRunDir);
    await ensureDir(worktreePublicDir);
    return {
      requestedStrategy: params.requestedStrategy,
      effectiveStrategy: "attempt_worktree",
      controlWorkspaceRoot: params.workspaceRoot,
      workspaceRoot: worktreePath,
      runDir: worktreeRunDir,
      publicDir: worktreePublicDir,
      metricsPath: worktreeMetricsPath,
      worktreePath,
      orphanedResiduePaths
    };
  } catch (error) {
    const attemptSnapshot = await createImplementAttemptSnapshot({
      workspaceRoot: params.workspaceRoot,
      runDir: params.runDir,
      attempt: params.attempt
    });
    return {
      requestedStrategy: params.requestedStrategy,
      effectiveStrategy: "attempt_snapshot_restore",
      fallbackFrom: "attempt_worktree",
      fallbackReason: `attempt_worktree fallback to snapshot/restore: ${
        error instanceof Error ? error.message : String(error)
      }`,
      controlWorkspaceRoot: params.workspaceRoot,
      workspaceRoot: params.workspaceRoot,
      runDir: params.runDir,
      publicDir: params.defaultPublicDir,
      metricsPath: params.metricsPath,
      attemptSnapshot,
      orphanedResiduePaths: [
        ...(attemptSnapshot.orphanedResiduePaths || [])
      ]
    };
  }
}

async function restoreIsolationContextForRetry(
  isolation: AttemptIsolationContext
): Promise<{ restoredPaths: string[] }> {
  if (isolation.effectiveStrategy === "attempt_snapshot_restore" && isolation.attemptSnapshot) {
    return isolation.attemptSnapshot.restore();
  }
  return { restoredPaths: [] };
}

async function cleanupIsolationContext(isolation: AttemptIsolationContext): Promise<{
  status: "completed" | "failed";
  notes: string[];
}> {
  if (isolation.effectiveStrategy === "attempt_snapshot_restore") {
    if (isolation.attemptSnapshot) {
      await isolation.attemptSnapshot.cleanup();
    }
    return {
      status: "completed",
      notes: []
    };
  }
  if (!isolation.worktreePath) {
    return {
      status: "completed",
      notes: []
    };
  }
  try {
    await cleanupManagedWorktree({
      workspaceRoot: isolation.controlWorkspaceRoot,
      worktreePath: isolation.worktreePath,
      isIsolatedWorkspaceRoot: false
    });
    return {
      status: "completed",
      notes: []
    };
  } catch (error) {
    return {
      status: "failed",
      notes: [error instanceof Error ? error.message : String(error)]
    };
  }
}

async function materializeWorktreeAttemptToPrimaryWorkspace(
  attempt: PreparedImplementAttempt,
  params: {
    fromWorkspaceRoot: string;
    toWorkspaceRoot: string;
  }
): Promise<PreparedImplementAttempt> {
  const translated = translatePreparedAttemptToWorkspace(attempt, params);
  await ensureDir(translated.publicDir);
  const candidates = dedupeStrings([
    attempt.publicDir,
    attempt.scriptPath,
    attempt.metricsPath,
    ...attempt.changedFiles,
    ...attempt.artifacts,
    ...attempt.publicArtifacts
  ]);
  for (const sourcePath of candidates) {
    const normalizedSource = normalizeStoredPath(sourcePath, params.fromWorkspaceRoot);
    if (!normalizedSource || !isPathInsideOrEqual(normalizedSource, params.fromWorkspaceRoot)) {
      continue;
    }
    const targetPath = translatePathBetweenWorkspaces(normalizedSource, params);
    if (!targetPath) {
      continue;
    }
    if (normalizedSource === attempt.publicDir) {
      await ensureDir(targetPath);
      continue;
    }
    await copyPathBetweenRoots(normalizedSource, targetPath);
  }
  return translated;
}

function translateTaskSpecToWorkspace(
  taskSpec: ImplementTaskSpec,
  params: {
    fromWorkspaceRoot: string;
    toWorkspaceRoot: string;
    runDir: string;
    publicDir: string;
    metricsPath: string;
  }
): ImplementTaskSpec {
  const translated = translateValueBetweenWorkspaces(taskSpec, params);
  translated.workspace = {
    root: params.toWorkspaceRoot,
    run_dir: params.runDir,
    public_dir: params.publicDir,
    metrics_path: params.metricsPath
  };
  return translated;
}

function translateLocalizationResultWorkspace(
  value: LocalizationResult,
  params: {
    fromWorkspaceRoot: string;
    toWorkspaceRoot: string;
  }
): LocalizationResult {
  return translateValueBetweenWorkspaces(value, params);
}

function translateBranchPlanWorkspace(
  value: BranchPlan,
  params: {
    fromWorkspaceRoot: string;
    toWorkspaceRoot: string;
  }
): BranchPlan {
  return translateValueBetweenWorkspaces(value, params);
}

function translateAttemptRecordWorkspace(
  value: AttemptRecord | undefined,
  params: {
    fromWorkspaceRoot: string;
    toWorkspaceRoot: string;
  }
): AttemptRecord | undefined {
  if (!value) {
    return undefined;
  }
  return translateValueBetweenWorkspaces(value, params);
}

function translatePreparedAttemptToWorkspace(
  value: PreparedImplementAttempt,
  params: {
    fromWorkspaceRoot: string;
    toWorkspaceRoot: string;
  }
): PreparedImplementAttempt {
  const translated = translateValueBetweenWorkspaces(value, params);
  translated.workspaceRoot = params.toWorkspaceRoot;
  return translated;
}

function translateMappedCodexEventToPrimaryWorkspace<T extends { payload: Record<string, unknown> }>(
  event: T,
  params: {
    fromWorkspaceRoot: string;
    toWorkspaceRoot: string;
  }
): T {
  return {
    ...event,
    payload: translateValueBetweenWorkspaces(event.payload, params)
  };
}

function translatePathsBetweenWorkspaces(
  values: string[],
  params: {
    fromWorkspaceRoot: string;
    toWorkspaceRoot: string;
  }
): string[] {
  return dedupeStrings(
    values.map((value) => translatePathBetweenWorkspaces(value, params) || value)
  );
}

function translatePathBetweenWorkspaces(
  value: string | undefined,
  params: {
    fromWorkspaceRoot: string;
    toWorkspaceRoot: string;
  }
): string | undefined {
  if (!value) {
    return value;
  }
  const normalized = normalizeStoredPath(value, params.fromWorkspaceRoot);
  if (!normalized || !isPathInsideOrEqual(normalized, params.fromWorkspaceRoot)) {
    return translateWorkspaceStringBetweenRoots(value, params);
  }
  const relative = path.relative(params.fromWorkspaceRoot, normalized);
  return normalizeFsPath(
    relative ? path.join(params.toWorkspaceRoot, relative) : params.toWorkspaceRoot
  );
}

function translateValueBetweenWorkspaces<T>(
  value: T,
  params: {
    fromWorkspaceRoot: string;
    toWorkspaceRoot: string;
  }
): T {
  if (typeof value === "string") {
    return translateWorkspaceStringBetweenRoots(value, params) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => translateValueBetweenWorkspaces(item, params)) as T;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      translateValueBetweenWorkspaces(nested, params)
    ])
  ) as T;
}

function translateWorkspaceStringBetweenRoots(
  value: string,
  params: {
    fromWorkspaceRoot: string;
    toWorkspaceRoot: string;
  }
): string {
  const aliases = resolveWorkspaceRootAliases(params.fromWorkspaceRoot)
    .concat([params.fromWorkspaceRoot])
    .sort((left, right) => right.length - left.length);
  let rewritten = value;
  for (const alias of aliases) {
    rewritten = replaceWorkspaceRootReference(rewritten, alias, params.toWorkspaceRoot);
  }
  return rewritten;
}

function resolveAttemptWorktreePath(runDir: string, attempt: number): string {
  return path.join(resolveAttemptWorktreeRoot(runDir), `attempt_${attempt}`);
}

function resolveAttemptWorktreeRoot(runDir: string): string {
  return path.join(runDir, "implement_experiments", "attempt_worktrees");
}

async function assertAttemptWorktreeReady(params: {
  workspaceRoot: string;
  runId: string;
}): Promise<void> {
  const repoRoot = normalizeFsPath(
    (await execFile("git", ["rev-parse", "--show-toplevel"], {
      cwd: params.workspaceRoot
    })).stdout.trim()
  );
  if (repoRoot !== normalizeFsPath(params.workspaceRoot)) {
    throw new Error("attempt_worktree requires the workspace root to be the git repository root");
  }

  const blockingDirtyPaths = await listBlockingWorktreeDirtyPaths(params);
  if (blockingDirtyPaths.length > 0) {
    throw new Error(
      `attempt_worktree requires a clean git workspace outside managed run artifacts; found ${blockingDirtyPaths
        .slice(0, 4)
        .join(", ")}${blockingDirtyPaths.length > 4 ? ", ..." : ""}`
    );
  }
}

async function listBlockingWorktreeDirtyPaths(params: {
  workspaceRoot: string;
  runId: string;
}): Promise<string[]> {
  const statusOutput = (
    await execFile("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: params.workspaceRoot
    })
  ).stdout;
  const allowedPrefixes = [
    normalizeFsPath(path.join(params.workspaceRoot, ".autolabos"))
  ];
  return statusOutput
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((entry) => entry.split(" -> ").at(-1) || entry)
    .map((entry) => normalizeStoredPath(entry, params.workspaceRoot) || "")
    .filter(Boolean)
    .filter(
      (filePath) => !allowedPrefixes.some((prefix) => isPathInsideOrEqual(normalizeFsPath(filePath), prefix))
    );
}

async function cleanupAttemptWorktreeResidue(params: {
  workspaceRoot: string;
  worktreeRoot: string;
  worktreePath: string;
}): Promise<string[]> {
  const orphanedResiduePaths: string[] = [];
  const candidates = new Set<string>();
  try {
    const entries = await fs.readdir(params.worktreeRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      candidates.add(path.join(params.worktreeRoot, entry.name));
    }
  } catch {
    // no managed residue root yet
  }
  candidates.add(params.worktreePath);
  for (const candidatePath of candidates) {
    try {
      await fs.access(candidatePath);
    } catch {
      continue;
    }
    orphanedResiduePaths.push(candidatePath);
    await cleanupManagedWorktree({
      workspaceRoot: params.workspaceRoot,
      worktreePath: candidatePath,
      isIsolatedWorkspaceRoot: false
    });
  }
  return orphanedResiduePaths;
}

async function cleanupManagedWorktree(params: {
  workspaceRoot: string;
  worktreePath: string;
  isIsolatedWorkspaceRoot: boolean;
}): Promise<void> {
  const normalizedWorktreePath = normalizeFsPath(params.worktreePath);
  if (!isManagedAttemptWorktreePath(normalizedWorktreePath, params.workspaceRoot)) {
    throw new Error(`Refusing to cleanup non-managed attempt worktree path: ${normalizedWorktreePath}`);
  }
  const controlCwd = params.isIsolatedWorkspaceRoot ? process.cwd() : params.workspaceRoot;
  try {
    await execFile("git", ["worktree", "remove", "--force", normalizedWorktreePath], {
      cwd: controlCwd
    });
  } catch {
    // Fall back to managed-path cleanup below.
  }
  try {
    await execFile("git", ["worktree", "prune"], {
      cwd: controlCwd
    });
  } catch {
    // best effort only
  }
  await fs.rm(normalizedWorktreePath, { recursive: true, force: true });
}

function isManagedAttemptWorktreePath(worktreePath: string, workspaceRoot: string): boolean {
  const managedRunsRoot = normalizeFsPath(path.join(workspaceRoot, ".autolabos", "runs"));
  const managedAttemptSegment = `${path.sep}implement_experiments${path.sep}attempt_worktrees${path.sep}`;
  return (
    isPathInsideOrEqual(worktreePath, managedRunsRoot) &&
    worktreePath.includes(managedAttemptSegment)
  );
}

async function copyPathBetweenRoots(sourcePath: string, targetPath: string): Promise<void> {
  try {
    const stat = await fs.lstat(sourcePath);
    await fs.rm(targetPath, { recursive: true, force: true });
    await ensureDir(path.dirname(targetPath));
    if (stat.isSymbolicLink()) {
      const linkTarget = await fs.readlink(sourcePath);
      await fs.symlink(linkTarget, targetPath);
      return;
    }
    if (stat.isDirectory()) {
      await fs.cp(sourcePath, targetPath, { recursive: true });
      return;
    }
    if (stat.isFile()) {
      await fs.copyFile(sourcePath, targetPath);
    }
  } catch {
    // Missing ephemeral files do not block materialization.
  }
}

async function listRestorableRunDirEntries(runDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(runDir);
    return entries
      .filter((entry) => !NON_RESTORABLE_RUN_DIR_ENTRIES.has(entry))
      .map((entry) => path.join(runDir, entry));
  } catch {
    return [];
  }
}

function isSubpath(filePath: string, parentDir: string): boolean {
  const relative = path.relative(parentDir, filePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isPathInsideOrEqual(filePath: string, parentDir: string): boolean {
  const relative = path.relative(parentDir, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveWorkspaceMemoryPath(workspaceRoot: string, memoryPath: string): string {
  return normalizeFsPath(path.isAbsolute(memoryPath) ? memoryPath : path.join(workspaceRoot, memoryPath));
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === "string");
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function replaceSetContents(target: Set<string>, values: string[]): void {
  target.clear();
  for (const value of values) {
    target.add(value);
  }
}

function normalizeLocalizationResult(
  value: unknown,
  workspaceRoot: string
): LocalizationResult | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const selectedFiles = (asStringArray(record.selected_files) || [])
    .map((item) => normalizeStoredPath(item, workspaceRoot))
    .filter((item): item is string => Boolean(item));
  const rawCandidates = Array.isArray(record.candidate_files) ? record.candidate_files : [];
  const candidates = rawCandidates
    .map((item) => normalizeLocalizationCandidate(item, workspaceRoot))
    .filter((item): item is LocalizationCandidate => Boolean(item));

  return {
    summary: asString(record.summary),
    strategy: asString(record.strategy),
    reasoning: asString(record.reasoning),
    selected_files: dedupeStrings(selectedFiles),
    candidates,
    confidence: asNumber(record.confidence),
    search_queries: asStringArray(record.search_queries),
    hits: normalizeLocalizationHits(record.hits, workspaceRoot)
  };
}

function normalizeLocalizationCandidate(
  value: unknown,
  workspaceRoot: string
): LocalizationCandidate | undefined {
  if (typeof value === "string") {
    const normalized = normalizeStoredPath(value, workspaceRoot);
    if (!normalized) {
      return undefined;
    }
    return {
      path: normalized,
      reason: "Candidate file selected by implementer."
    };
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const normalizedPath = normalizeStoredPath(asString(record.path), workspaceRoot);
  if (!normalizedPath) {
    return undefined;
  }
  return {
    path: normalizedPath,
    symbol: asString(record.symbol),
    reason: asString(record.reason) || "Candidate file selected by implementer.",
    confidence: asNumber(record.confidence)
  };
}

function normalizeLocalizationHits(
  value: unknown,
  workspaceRoot: string
): LocalizationSearchHit[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const hits: LocalizationSearchHit[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    const normalizedPath = normalizeStoredPath(asString(record.path), workspaceRoot);
    const query = asString(record.query);
    const source = asString(record.source);
    if (
      !normalizedPath ||
      !query ||
      !source ||
      !["search_code", "find_symbol", "list_files"].includes(source)
    ) {
      continue;
    }
    hits.push({
      path: normalizedPath,
      line: asNumber(record.line) || undefined,
      excerpt: asString(record.excerpt),
      query,
      source: source as LocalizationSearchHit["source"]
    });
  }
  return hits;
}

function inferLocalizationFromArtifacts(params: {
  changedFiles: string[];
  scriptPath?: string;
  publicDir?: string;
}): LocalizationResult {
  const selected = dedupeStrings(
    [params.scriptPath, ...params.changedFiles]
      .filter((item): item is string => typeof item === "string")
      .filter((item) => item !== params.publicDir)
      .slice(0, 8)
  );
  return {
    summary: selected.length > 0 ? "Inferred localization from changed files." : "Localization unavailable.",
    strategy: "artifact_inference",
    reasoning:
      selected.length > 0
        ? "Used the generated script path and changed files because the model did not return explicit localization."
        : "No changed files were available to infer localization.",
    selected_files: selected,
    candidates: selected.map((filePath) => ({
      path: filePath,
      reason: "Changed during the implementation attempt."
    }))
  };
}

function emptyLocalizationResult(): LocalizationResult {
  return {
    summary: "Localization unavailable.",
    strategy: "model_localization",
    reasoning: "The implementation response did not include localization metadata.",
    selected_files: [],
    candidates: []
  };
}

async function buildDefaultImplementFocusFiles(taskSpec: ImplementTaskSpec): Promise<string[]> {
  const publicScripts = await listImplementationScripts(taskSpec.workspace.public_dir);
  return dedupeStrings([
    ...publicScripts,
    path.join(taskSpec.workspace.public_dir, "experiment.py"),
    path.join(taskSpec.workspace.run_dir, "experiment_plan.yaml")
  ]);
}

export function applyRunnerFeedbackLocalizationGuard(
  taskSpec: ImplementTaskSpec,
  localization: LocalizationResult,
  defaultFocusFiles: string[]
): LocalizationResult {
  const feedback = taskSpec.context.runner_feedback;
  if (!feedback || feedback.source !== "run_experiments") {
    return localization;
  }

  const publicDir = taskSpec.workspace.public_dir;
  const feedbackText = [
    feedback.summary,
    feedback.stderr_excerpt,
    feedback.stdout_excerpt,
    feedback.command,
    feedback.suggested_next_action
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  const runnerFocus = prioritizeRunnerFeedbackFocus(
    dedupeStrings([
      ...defaultFocusFiles,
      ...localization.selected_files,
      ...localization.candidates.map((candidate) => candidate.path)
    ])
      .filter((filePath) => /\.(py|sh|js|mjs|cjs)$/iu.test(filePath))
      .filter((filePath) => filePath.startsWith(publicDir + path.sep)),
    feedbackText
  );
  if (runnerFocus.length === 0) {
    return localization;
  }

  const isExperimentRuntimeFeedback =
    /\bmetrics?\b|\bobjective metric\b|\bcompleted_condition_count\b|\bcommand failed\b|\btraceback\b/iu.test(feedbackText) ||
    /\.(py|sh)(?:["'\s]|$)/iu.test(feedbackText);
  if (!isExperimentRuntimeFeedback) {
    return localization;
  }

  const selectedFiles = dedupeStrings([
    ...runnerFocus,
    ...localization.selected_files.filter((filePath) => !filePath.includes(`${path.sep}paper${path.sep}`))
  ]).slice(0, 6);
  const runnerCandidates: LocalizationCandidate[] = runnerFocus.map((filePath) => ({
    path: filePath,
    reason: "run_experiments feedback targets the runnable experiment command/metrics contract.",
    confidence: 0.95
  }));

  return {
    ...localization,
    summary: "Localized runner feedback to the public experiment runner.",
    strategy: dedupeStrings(["runner_feedback_guard", localization.strategy || ""])
      .filter(Boolean)
      .join("+"),
    reasoning: [
      "run_experiments feedback should repair the runnable experiment script before paper artifacts.",
      localization.reasoning
    ]
      .filter(Boolean)
      .join(" | "),
    selected_files: selectedFiles,
    candidates: mergeLocalizationCandidates([
      ...runnerCandidates,
      ...localization.candidates.filter((candidate) => !candidate.path.includes(`${path.sep}paper${path.sep}`))
    ]),
    confidence: Math.max(localization.confidence || 0, 0.95)
  };
}

export function applyImplementationContractLocalizationGuard(
  taskSpec: ImplementTaskSpec,
  localization: LocalizationResult,
  defaultFocusFiles: string[]
): LocalizationResult {
  const feedback = taskSpec.context.implementation_contract_feedback;
  const hasPlannedScheduleContract = hasConcretePlannedConditionContract(taskSpec);
  if (!isImplementationScheduleContractRepair(taskSpec) && !hasPlannedScheduleContract) {
    return localization;
  }

  const publicDir = taskSpec.workspace.public_dir;
  const feedbackText = [
    feedback?.summary,
    feedback?.stderr_excerpt,
    feedback?.suggested_next_action,
    taskSpec.context.planned_condition_contract
      ? JSON.stringify(taskSpec.context.planned_condition_contract)
      : undefined,
    ...(feedback?.blocking_findings.flatMap((finding) => [finding.code, finding.message, finding.evidence || ""]) || [])
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  const publicScriptCandidates = dedupeStrings([
    ...defaultFocusFiles,
    ...localization.selected_files,
    ...localization.candidates.map((candidate) => candidate.path)
  ])
    .filter((filePath) => /\.(py|sh|js|mjs|cjs)$/iu.test(filePath))
    .filter((filePath) => filePath.startsWith(publicDir + path.sep));
  const runnerFocus = prioritizeImplementationContractFocus(publicScriptCandidates, feedbackText);
  if (runnerFocus.length === 0) {
    return localization;
  }

  const selectedFiles = dedupeStrings([
    ...runnerFocus,
    ...localization.selected_files.filter((filePath) => !filePath.includes(`${path.sep}paper${path.sep}`))
  ]).slice(0, 6);
  const contractCandidates: LocalizationCandidate[] = runnerFocus.map((filePath) => ({
    path: filePath,
    reason:
      "implement_experiments contract feedback targets the canonical runnable script and its planned condition/run schedule.",
    confidence: 0.98
  }));

  return {
    ...localization,
    summary: feedback
      ? "Localized implementation contract feedback to the canonical public experiment runner."
      : "Localized planned condition contract work to the canonical public experiment runner.",
    strategy: dedupeStrings(["implementation_contract_guard", localization.strategy || ""])
      .filter(Boolean)
      .join("+"),
    reasoning: [
      feedback
        ? "Design-to-implementation contract failures should repair the runnable schedule contract before exploring alternate scripts."
        : "Concrete planned condition contracts should be implemented in runnable experiment scripts before paper artifacts are edited.",
      localization.reasoning
    ]
      .filter(Boolean)
      .join(" | "),
    selected_files: selectedFiles,
    candidates: mergeLocalizationCandidates([
      ...contractCandidates,
      ...localization.candidates.filter((candidate) => !candidate.path.includes(`${path.sep}paper${path.sep}`))
    ]),
    confidence: Math.max(localization.confidence || 0, 0.98)
  };
}

function hasConcretePlannedConditionContract(taskSpec: ImplementTaskSpec): boolean {
  const contract = taskSpec.context.planned_condition_contract;
  if (!contract) {
    return false;
  }
  return Boolean(
    (contract.required_condition_markers && contract.required_condition_markers.length > 1) ||
      (contract.required_condition_count && contract.required_condition_count > 1) ||
      (contract.required_run_count && contract.required_run_count > 1) ||
      (contract.minimum_seeds_per_condition && contract.minimum_seeds_per_condition > 1) ||
      (contract.seed_schedule && contract.seed_schedule.length > 1)
  );
}

function isImplementationScheduleContractRepair(taskSpec: ImplementTaskSpec): boolean {
  const feedback = taskSpec.context.implementation_contract_feedback;
  if (!feedback || feedback.status !== "fail" || feedback.stage !== "design_implementation_validation") {
    return false;
  }
  const text = [
    feedback.summary,
    feedback.stderr_excerpt,
    feedback.suggested_next_action,
    ...feedback.blocking_findings.flatMap((finding) => [finding.code, finding.message, finding.evidence || ""])
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  return /\bPLANNED_(?:CONDITION|RUN|SEED)_/u.test(text);
}

function enforceUnresolvedImplementationContractFeedback(
  report: ExperimentDesignImplementationValidationReport,
  taskSpec: ImplementTaskSpec
): ExperimentDesignImplementationValidationReport {
  if (
    report.verdict === "block" ||
    taskSpec.context.planned_condition_contract ||
    !isImplementationScheduleContractRepair(taskSpec)
  ) {
    return report;
  }

  return {
    ...report,
    verdict: "block",
    summary:
      "Design-to-implementation validation blocked handoff because prior planned-condition feedback remains unverifiable without the current planned condition contract.",
    checked_items: dedupeStrings([
      ...report.checked_items,
      "implementation_contract_feedback_resolution"
    ]),
    findings: [
      ...report.findings,
      {
        code: "IMPLEMENTATION_CONTRACT_FEEDBACK_UNVERIFIED",
        severity: "block",
        message:
          "A previous implement_experiments contract failure reported planned condition/run contraction, but the current task spec has no planned-condition contract to prove the repair.",
        evidence:
          taskSpec.context.implementation_contract_feedback?.summary ||
          "implementation_contract_feedback present without planned_condition_contract"
      }
    ]
  };
}

function prioritizeRunnerFeedbackFocus(filePaths: string[], feedbackText: string): string[] {
  const scored = filePaths.map((filePath, index) => {
    const basename = path.basename(filePath);
    let score = 0;
    if (feedbackText.includes(filePath)) score += 100;
    if (feedbackText.includes(basename)) score += 80;
    if (/^run_.*\.(py|js|mjs|cjs|sh)$/iu.test(basename)) score += 30;
    if (/study|experiment|runner/iu.test(basename)) score += 10;
    if (basename === "experiment.py") score -= 20;
    if (basename === "run_command.sh") score -= 10;
    return { filePath, index, score };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.filePath);
}

function prioritizeImplementationContractFocus(filePaths: string[], feedbackText: string): string[] {
  const scored = filePaths.map((filePath, index) => {
    const basename = path.basename(filePath);
    let score = 0;
    if (feedbackText.includes(filePath)) score += 100;
    if (feedbackText.includes(basename)) score += 80;
    if (/^run_.*experiment.*\.(py|js|mjs|cjs)$/iu.test(basename)) score += 70;
    if (/^run_.*study.*\.(py|js|mjs|cjs)$/iu.test(basename)) score += 35;
    if (/^run_.*\.(py|js|mjs|cjs|sh)$/iu.test(basename)) score += 25;
    if (/study|experiment|runner/iu.test(basename)) score += 10;
    if (basename === "experiment.py") score -= 25;
    if (basename === "run_command.sh") score -= 20;
    return { filePath, index, score };
  });
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.filePath);
}

async function listImplementationScripts(publicDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(publicDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.(py|js|sh|mjs|cjs)$/i.test(entry.name))
      .map((entry) => path.join(publicDir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function chooseBranchPlan(
  searchLocalization: LocalizationResult,
  attemptRecords: AttemptRecord[],
  changedFiles: string[],
  defaultFocusFiles: string[],
  options?: {
    lockFocusToLocalization?: boolean;
    lockReason?: string;
  }
): BranchPlan {
  const focusPool = dedupeStrings([
    ...searchLocalization.selected_files,
    ...searchLocalization.candidates.map((candidate) => candidate.path),
    ...changedFiles,
    ...defaultFocusFiles
  ]).filter(isLikelyBranchFocusFile);
  const triedPaths = new Set(
    attemptRecords.flatMap((record) => record.branch_plan.focus_files)
  );
  const primaryPool = focusPool.length > 0
    ? focusPool
    : dedupeStrings([
        ...searchLocalization.selected_files,
        ...searchLocalization.candidates.map((candidate) => candidate.path),
        ...changedFiles,
        ...defaultFocusFiles
      ]);
  const untried = primaryPool.filter((filePath) => !triedPaths.has(filePath));
  const lockFocusFiles = primaryPool.slice(0, SEARCH_BRANCH_FOCUS_LIMIT);

  if (options?.lockFocusToLocalization && attemptRecords.length > 0) {
    return {
      branch_id: `branch_contract_repair_${attemptRecords.length + 1}`,
      source: "repair_retry",
      summary: "Contract repair branch pinned to the canonical runnable implementation.",
      rationale:
        options.lockReason ||
        "Contract feedback requires repairing the selected runnable implementation before exploring alternate candidates.",
      focus_files: lockFocusFiles,
      candidate_pool: primaryPool.slice(0, 6)
    };
  }

  if (attemptRecords.length === 0) {
    return {
      branch_id: "branch_primary",
      source: "search_primary",
      summary: "Primary search-guided implementation branch.",
      rationale:
        searchLocalization.reasoning ||
        "Use the highest-confidence search-backed candidate files first.",
      focus_files: lockFocusFiles,
      candidate_pool: primaryPool.slice(0, 6)
    };
  }

  if (untried.length > 0) {
    return {
      branch_id: `branch_alternate_${attemptRecords.length + 1}`,
      source: "search_alternate",
      summary: "Alternate search-guided implementation branch.",
      rationale:
        "Prior branch failed local verification, so this branch explores the next-best untried candidates.",
      focus_files: untried.slice(0, SEARCH_BRANCH_FOCUS_LIMIT),
      candidate_pool: primaryPool.slice(0, 6)
    };
  }

  const fallbackFocus = dedupeStrings([
    ...changedFiles,
    ...primaryPool
  ]).slice(0, 2);
  return {
    branch_id: `branch_repair_${attemptRecords.length + 1}`,
    source: "repair_retry",
    summary: "Repair branch that stays close to the previously edited files.",
    rationale:
      "No untried localization candidates remained, so this branch revisits the changed files and strongest prior candidates.",
    focus_files: fallbackFocus,
    candidate_pool: primaryPool.slice(0, 6)
  };
}

async function loadImplementationLongTermMemory(
  longTermStore: LongTermStore,
  run: RunRecord
): Promise<LongTermMemorySnapshot> {
  const queries = buildImplementationMemoryQueries(run);
  const entries = (await longTermStore.readAll()).filter(isImplementationLongTermEntry);
  const retrieved = entries
    .map((entry) => ({
      entry,
      score: scoreImplementationMemoryEntry(entry, queries)
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.entry.createdAt) - Date.parse(a.entry.createdAt))
    .slice(0, 3)
    .map((row) => summarizeLongTermEntry(row.entry));

  return {
    search_queries: queries.map((query) => trimBlock(sanitizeReusableImplementationMemoryText(query), 120)),
    retrieved
  };
}

async function saveSuccessfulImplementationMemory(
  longTermStore: LongTermStore,
  params: {
    run: RunRecord;
    attempt: PreparedImplementAttempt;
    taskSpec: ImplementTaskSpec;
    verifyReport: VerifyReport;
    localization: LocalizationResult;
  }
): Promise<LongTermMemoryHint> {
  const focusFiles = dedupeStrings([
    ...params.attempt.branchPlan.focus_files,
    ...params.localization.selected_files
  ])
    .map((filePath) => path.basename(filePath))
    .slice(0, 4);
  const entry = await longTermStore.append({
    runId: params.run.id,
    category: "implementation",
    text: buildSuccessfulImplementationLesson(params),
    tags: dedupeStrings([
      "implement_experiments",
      params.attempt.experimentMode,
      params.run.topic,
      params.run.objectiveMetric,
      ...focusFiles
    ]).slice(0, 8)
  });
  return summarizeLongTermEntry(entry);
}

function buildImplementationMemoryQueries(run: RunRecord): string[] {
  return dedupeStrings([
    "implement_experiments",
    oneLine(run.topic),
    oneLine(run.objectiveMetric),
    ...run.constraints.map((constraint) => oneLine(constraint)).filter((constraint) => constraint.length <= 80)
  ]).slice(0, 6);
}

function isImplementationLongTermEntry(entry: LongTermEntry): boolean {
  return entry.category === "implementation" || entry.tags.some((tag) => tag.toLowerCase() === "implement_experiments");
}

function scoreImplementationMemoryEntry(entry: LongTermEntry, queries: string[]): number {
  const haystack = `${entry.category}\n${entry.text}\n${entry.tags.join("\n")}`.toLowerCase();
  let score = entry.category === "implementation" ? 5 : 0;
  if (entry.tags.some((tag) => tag.toLowerCase() === "implement_experiments")) {
    score += 3;
  }
  for (const query of queries) {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    if (haystack.includes(normalized)) {
      score += 2;
    }
    if (entry.tags.some((tag) => tag.toLowerCase() === normalized)) {
      score += 2;
    }
  }
  return score;
}

function summarizeLongTermEntry(entry: LongTermEntry): LongTermMemoryHint {
  return {
    id: entry.id,
    category: entry.category,
    text: trimBlock(sanitizeReusableImplementationMemoryText(entry.text), 320),
    tags: dedupeStrings(entry.tags.map(sanitizeImplementationMemoryTag)).slice(0, 8),
    created_at: entry.createdAt
  };
}

function sanitizeReusableImplementationMemoryText(text: string): string {
  return text
    .replace(
      /Successful implement_experiments lesson for topic "[^"]*" targeting [^.]+\./giu,
      "Successful implement_experiments lesson for a completed implementation task."
    )
    .replace(/\b[A-Za-z][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\b/gu, "configured_model")
    .replace(/\b[a-z][a-z0-9_]*(?:experiment|study|backend|runner)[a-z0-9_]*\.(?:py|sh)\b/giu, "generated_script")
    .replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/giu, "run_id")
    .replace(/\b[a-z][a-z0-9-]*-[0-9a-f]{8,}\b/giu, "run_output_slug");
}

function sanitizeImplementationMemoryTag(tag: string): string {
  const sanitized = sanitizeReusableImplementationMemoryText(tag).trim();
  if (!sanitized || sanitized !== tag || tag.length > 96 || /[/.]/u.test(tag)) {
    return "implementation_lesson";
  }
  return sanitized;
}

function buildSuccessfulImplementationLesson(params: {
  run: RunRecord;
  attempt: PreparedImplementAttempt;
  taskSpec: ImplementTaskSpec;
  verifyReport: VerifyReport;
  localization: LocalizationResult;
}): string {
  const focusFiles = dedupeStrings([
    ...params.attempt.branchPlan.focus_files,
    ...params.localization.selected_files
  ])
    .map((filePath) => sanitizeImplementationMemoryTag(path.basename(filePath)))
    .filter((tag) => tag !== "implementation_lesson")
    .slice(0, 4);
  const verificationCommand = sanitizeReusableImplementationMemoryText(
    params.verifyReport.command || params.attempt.testCommand || "local verification"
  );
  const lesson = [
    "Successful implement_experiments lesson for a completed implementation task.",
    focusFiles.length > 0 ? `Prefer the focused artifact role(s) ${focusFiles.join(", ")}.` : "Keep the patch tightly focused.",
    `Verification passed via ${oneLine(verificationCommand)}.`,
    "Keep reusable artifacts in the public experiment directory and metrics at the run metrics path.",
    sanitizeReusableImplementationMemoryText(oneLine(params.attempt.summary))
  ].join(" ");
  return trimBlock(lesson, 480);
}

function shouldAutoHandoffToRunExperiments(verifyReport: VerifyReport): boolean {
  if (verifyReport.status !== "pass") {
    return false;
  }
  return verifyReport.next_action === "accept" || verifyReport.next_action === "handoff_to_run_experiments";
}

function buildRunExperimentsHandoffReason(verifyReport: VerifyReport): string {
  if (verifyReport.status === "pass" && verifyReport.command) {
    return `Local verification passed via ${verifyReport.command}; continue with run_experiments as the second-stage verifier.`;
  }
  if (verifyReport.status === "not_run") {
    return "No lightweight local verification command was available; defer verification to run_experiments.";
  }
  return "Implementation is ready for second-stage verification in run_experiments.";
}

function mergeLocalizationResults(
  searchLocalization: LocalizationResult | undefined,
  modelLocalization: LocalizationResult | undefined,
  fallbackLocalization: LocalizationResult
): LocalizationResult {
  const search = searchLocalization || emptyLocalizationResult();
  const model = modelLocalization || emptyLocalizationResult();
  const selectedFiles = dedupeStrings([
    ...model.selected_files,
    ...search.selected_files,
    ...fallbackLocalization.selected_files
  ]).slice(0, 6);

  const mergedCandidates = mergeLocalizationCandidates([
    ...model.candidates,
    ...search.candidates,
    ...fallbackLocalization.candidates
  ]);

  const confidenceValues = [model.confidence, search.confidence, fallbackLocalization.confidence]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const hits = dedupeLocalizationHits([
    ...(search.hits || []),
    ...(model.hits || [])
  ]);
  const searchQueries = dedupeStrings([
    ...(search.search_queries || []),
    ...(model.search_queries || [])
  ]);

  return {
    summary:
      model.summary ||
      search.summary ||
      fallbackLocalization.summary,
    strategy: dedupeStrings([
      model.strategy || "",
      search.strategy || "",
      fallbackLocalization.strategy || ""
    ])
      .filter(Boolean)
      .join("+"),
    reasoning: [model.reasoning, search.reasoning, fallbackLocalization.reasoning]
      .filter((value): value is string => Boolean(value))
      .join(" | "),
    selected_files: selectedFiles.length > 0 ? selectedFiles : fallbackLocalization.selected_files,
    candidates: mergedCandidates.length > 0 ? mergedCandidates : fallbackLocalization.candidates,
    confidence:
      confidenceValues.length > 0
        ? Math.max(...confidenceValues)
        : fallbackLocalization.confidence,
    search_queries: searchQueries.length > 0 ? searchQueries : undefined,
    hits: hits.length > 0 ? hits : undefined
  };
}

function deriveLesson(
  failureType: ImplementFailureType | undefined,
  branchPlan: BranchPlan
): string {
  if (failureType === "environment") {
    return "The branch failed because the local environment or command was not runnable, not because the patch itself was clearly wrong.";
  }
  if (failureType === "policy") {
    return "The branch failed because the verification command violated the execution policy, so the next attempt should replace the blocked command instead of retrying it.";
  }
  if (failureType === "localization") {
    return `The branch focus ${branchPlan.branch_id} likely targeted the wrong files, so the next branch should pivot to different candidates.`;
  }
  if (failureType === "spec") {
    return "The command or implementation disagreed with the task contract, so the next branch should re-check the required run/test contract.";
  }
  return `The branch focus ${branchPlan.branch_id} was close enough to edit, but the resulting patch still failed local verification.`;
}

function deriveNextTryInstruction(
  verifyReport: VerifyReport,
  branchPlan: BranchPlan
): string {
  if (verifyReport.next_action === "relocalize") {
    return "Select a different branch focus and avoid reusing the same file subset unless new evidence supports it.";
  }
  if (verifyReport.next_action === "stop_for_environment") {
    return "Do not keep patching blindly; resolve the missing runtime dependency or command issue first.";
  }
  if (verifyReport.next_action === "stop_for_policy") {
    return "Do not retry the blocked command; replace it with a policy-compliant local check or hand the verification off safely.";
  }
  if (branchPlan.source === "repair_retry") {
    return "Keep the fix narrow and address the exact local verification failure in the current focus files.";
  }
  return "Try the next branch candidate set and make the smallest patch that addresses the failing verification signal.";
}

function mergeLocalizationCandidates(candidates: LocalizationCandidate[]): LocalizationCandidate[] {
  const merged = new Map<string, LocalizationCandidate>();
  for (const candidate of candidates) {
    const existing = merged.get(candidate.path);
    if (!existing) {
      merged.set(candidate.path, { ...candidate });
      continue;
    }
    merged.set(candidate.path, {
      path: candidate.path,
      symbol: existing.symbol || candidate.symbol,
      reason: dedupeStrings([existing.reason, candidate.reason]).join("; "),
      confidence: Math.max(existing.confidence || 0, candidate.confidence || 0) || undefined
    });
  }
  return [...merged.values()].slice(0, 8);
}

function dedupeLocalizationHits(hits: LocalizationSearchHit[]): LocalizationSearchHit[] {
  const seen = new Set<string>();
  const out: LocalizationSearchHit[] = [];
  for (const hit of hits) {
    const key = `${hit.source}:${hit.query}:${hit.path}:${hit.line || 0}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(hit);
  }
  return out.slice(0, 24);
}

function isLikelyBranchFocusFile(filePath: string): boolean {
  if (filePath.includes(`${path.sep}.autolabos${path.sep}`)) {
    return false;
  }
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|sh|json|yaml|yml)$/iu.test(filePath);
}

function formatLocalizationSummary(localization: LocalizationResult): string {
  if (localization.selected_files.length === 0 && localization.candidates.length === 0) {
    return "Localization did not identify any concrete files.";
  }
  const targets = localization.selected_files.length > 0
    ? localization.selected_files
    : localization.candidates.map((candidate) => candidate.path).slice(0, 3);
  return `Localized implementation to: ${targets.join(", ")}`;
}

function deriveFallbackTestCommand(scriptPath: string | undefined): string | undefined {
  if (!scriptPath) {
    return undefined;
  }
  const quoted = JSON.stringify(scriptPath);
  if (/\.py$/i.test(scriptPath)) {
    return `python3 -m py_compile ${quoted}`;
  }
  if (/\.(js|mjs|cjs)$/i.test(scriptPath)) {
    return `node --check ${quoted}`;
  }
  if (/\.sh$/i.test(scriptPath)) {
    return `bash -n ${quoted}`;
  }
  return undefined;
}

function getImplementLlmProgressHeartbeatMs(): number {
  const raw = process.env.AUTOLABOS_IMPLEMENT_LLM_PROGRESS_HEARTBEAT_MS;
  if (raw == null || raw.trim() === "") {
    return 60_000;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 60_000;
  }
  return Math.max(0, Math.floor(parsed));
}

function buildMissingArtifactVerifyReport(
  isStructured: boolean,
  options?: {
    command?: string;
    missingArtifacts?: string[];
    workspaceRoot?: string;
  }
): VerifyReport {
  const missingArtifacts = options?.missingArtifacts || [];
  if (missingArtifacts.length > 0) {
    const renderedMissingArtifacts = missingArtifacts
      .map((filePath) => formatArtifactPath(filePath, options?.workspaceRoot))
      .join(", ");
    const summary = options?.command
      ? `Local verification could not start because required artifact(s) were not materialized for ${options.command}: ${renderedMissingArtifacts}`
      : `Implementer referenced artifact(s) that were not materialized: ${renderedMissingArtifacts}`;
    return {
      status: "fail",
      failure_type: "spec",
      next_action: "retry_patch",
      command: options?.command,
      stderr_excerpt: `Missing artifact(s): ${renderedMissingArtifacts}`,
      summary
    };
  }
  return {
    status: "fail",
    failure_type: "spec",
    next_action: "retry_patch",
    summary: isStructured
      ? "Implementer did not return a runnable artifact or run_command."
      : "Implementer did not return the required JSON result or any runnable artifact."
  };
}

function buildDesignImplementationValidationVerifyReport(
  report: ExperimentDesignImplementationValidationReport
): VerifyReport {
  const blockingFindings = report.findings.filter((finding) => finding.severity === "block");
  const renderedFinding = blockingFindings
    .map((finding) => `${finding.code}: ${finding.message}${finding.evidence ? ` (${finding.evidence})` : ""}`)
    .join("; ");
  return {
    status: "fail",
    failure_type: "spec",
    next_action: "retry_patch",
    stderr_excerpt: renderedFinding || report.summary,
    summary: renderedFinding
      ? `Design-to-implementation contract validation failed: ${renderedFinding}`
      : report.summary
  };
}

function buildImplementationContractFeedback(
  verifyReport: VerifyReport | undefined,
  validation: ExperimentDesignImplementationValidationReport | undefined
): ImplementationContractFeedback | undefined {
  const blockingFindings = (validation?.findings || [])
    .filter((finding) => finding.severity === "block")
    .map((finding) => ({
      code: finding.code,
      message: finding.message,
      evidence: finding.evidence
    }));
  const isContractBlock =
    validation?.verdict === "block" ||
    (verifyReport?.status === "fail" &&
      verifyReport.failure_type === "spec" &&
      /design-to-implementation contract validation failed/iu.test(verifyReport.summary || ""));
  const isLocalVerificationBlock =
    verifyReport?.status === "fail" &&
    verifyReport.next_action === "retry_patch" &&
    !isContractBlock;
  if ((!isContractBlock && !isLocalVerificationBlock) || !verifyReport) {
    return undefined;
  }
  const verificationText = `${verifyReport.summary}\n${verifyReport.stderr_excerpt || ""}`;
  const localFailureCode = /AUTOLABOS SECTION skeleton markers/iu.test(verificationText)
    ? "PYTHON_SECTION_SKELETON_MARKERS_PRESENT"
    : /budget-limited partial execution/iu.test(verificationText) ||
        (/completed_model_execution/iu.test(verificationText) && /\b(?:timeout|budget|coverage)\b/iu.test(verificationText))
      ? "BUDGET_TIMEOUT_PARTIAL_SUCCESS_HANDOFF"
      : /critical runtime helper|Undefined helper call|name ["\x27][A-Za-z_]\w*["\x27] is not defined/iu.test(verificationText)
        ? "PYTHON_UNDEFINED_RUNTIME_HELPER_REFERENCE"
        : "IMPLEMENT_LOCAL_VERIFICATION_FAILED";
  return {
    source: "implement_experiments",
    status: "fail",
    stage: isContractBlock ? "design_implementation_validation" : "local_verification",
    summary: verifyReport.summary,
    stderr_excerpt: verifyReport.stderr_excerpt,
    blocking_findings: isContractBlock
      ? blockingFindings.slice(0, 12)
      : [
          {
            code: localFailureCode,
            message: trimBlock(verifyReport.summary, 520),
            evidence: trimBlock(verifyReport.stderr_excerpt || "", 520) || undefined
          }
        ],
    suggested_next_action: isLocalVerificationBlock
      ? localFailureCode === "PYTHON_SECTION_SKELETON_MARKERS_PRESENT"
        ? "Regenerate or repair the public Python runner so no AUTOLABOS SECTION skeleton markers remain in any verification surface before run_experiments is retried."
        : localFailureCode === "BUDGET_TIMEOUT_PARTIAL_SUCCESS_HANDOFF"
          ? "Regenerate the execution, evaluation, metrics, and entrypoint sections so timeout or budget-infeasible partial coverage emits a failed/blocked payload instead of completed_model_execution before run_experiments is retried."
          : localFailureCode === "PYTHON_UNDEFINED_RUNTIME_HELPER_REFERENCE"
            ? "Regenerate or define the runtime helper and its execution/evaluation/metrics call sites before run_experiments is retried; py_compile alone is not runnable experiment evidence."
            : "Repair the latest local verification failure from implement_experiments before addressing older run_experiments runtime feedback."
      : blockingFindings.some(
          (finding) => finding.code === "PLANNED_PER_RUN_EXECUTION_HELPER_MISSING"
        )
        ? "Regenerate the runnable experiment script so the approved condition-by-seed loop calls a concrete per-run execution helper; metrics-only shells or resolvers that search only missing helpers must not pass implement_experiments."
        : "Regenerate the implementation so static validation can see every approved condition and every condition-by-seed run before run_experiments executes it.",
    recorded_at: new Date().toISOString()
  };
}

function buildImplementationTurnFailureReport(errorMessage: string): VerifyReport {
  return {
    status: "fail",
    failure_type: "environment",
    next_action: "stop_for_environment",
    stderr_excerpt: trimBlock(errorMessage, 1200) || errorMessage,
    summary: `Implementation execution failed before any runnable implementation was produced: ${errorMessage}`
  };
}

async function collectMissingVerificationArtifacts(params: {
  command: string;
  cwd: string;
  workspaceRoot: string;
  scriptPath?: string;
}): Promise<string[]> {
  const candidates = dedupeStrings([
    ...(params.scriptPath ? [params.scriptPath] : []),
    ...extractWorkspacePathsFromCommand(params.command, params.cwd, params.workspaceRoot)
  ]);
  const missing: string[] = [];
  for (const candidate of candidates) {
    if (isDeferredExecutionArtifactPath(candidate)) {
      continue;
    }
    if (!(await fileExists(candidate))) {
      missing.push(candidate);
    }
  }
  return missing.sort();
}

export function extractWorkspacePathsFromCommand(command: string, cwd: string, workspaceRoot: string): string[] {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const paths = new Set<string>();
  let skipNextOutputRedirectTarget = false;
  let skipNextRuntimeOutputOptionTarget = false;
  let parseNextShellCommandString = false;
  for (const token of tokens) {
    if (skipNextOutputRedirectTarget) {
      skipNextOutputRedirectTarget = false;
      continue;
    }
    if (skipNextRuntimeOutputOptionTarget) {
      skipNextRuntimeOutputOptionTarget = false;
      continue;
    }
    if (parseNextShellCommandString) {
      parseNextShellCommandString = false;
      const nestedCommand = token.replace(/^['"]|['"]$/g, "");
      for (const nestedPath of extractWorkspacePathsFromCommand(nestedCommand, cwd, workspaceRoot)) {
        paths.add(nestedPath);
      }
      continue;
    }
    const shellOptionToken = token.trim();
    if (/^-[a-z]*c[a-z]*$/iu.test(shellOptionToken)) {
      parseNextShellCommandString = true;
      continue;
    }
    const runtimeOutputOption = classifyRuntimeOutputOptionToken(shellOptionToken);
    if (runtimeOutputOption === "separate-target") {
      skipNextRuntimeOutputOptionTarget = true;
      continue;
    }
    if (runtimeOutputOption === "attached-target") {
      continue;
    }
    const outputRedirection = classifyShellOutputRedirectionToken(token);
    if (outputRedirection === "separate-target") {
      skipNextOutputRedirectTarget = true;
      continue;
    }
    if (outputRedirection === "attached-target") {
      continue;
    }

    const normalized = normalizeWorkspacePathToken(extractShellInputRedirectionTarget(token) || token);
    if (!normalized) {
      continue;
    }
    if (!looksLikeWorkspacePath(normalized)) {
      continue;
    }
    const resolved = normalizeStoredPath(
      path.isAbsolute(normalized) ? normalized : path.resolve(cwd, normalized),
      workspaceRoot
    );
    if (resolved) {
      paths.add(resolved);
    }
  }
  return [...paths];
}

type RuntimeOutputOptionToken = "none" | "separate-target" | "attached-target";

function classifyRuntimeOutputOptionToken(token: string): RuntimeOutputOptionToken {
  const value = token.trim().replace(/^['"]|['"]$/g, "");
  if (!value) {
    return "none";
  }
  const optionPattern =
    /^(?:--?(?:output|out|results?|reports?|logs?|cache)[_-]?(?:dir|directory|path|file)?|--?(?:metrics|results?)[_-]?path)$/iu;
  const assignmentMatch = value.match(/^([^=]+)=.+$/u);
  if (assignmentMatch?.[1] && optionPattern.test(assignmentMatch[1])) {
    return "attached-target";
  }
  return optionPattern.test(value) ? "separate-target" : "none";
}

type ShellOutputRedirectionToken = "none" | "separate-target" | "attached-target";

function classifyShellOutputRedirectionToken(token: string): ShellOutputRedirectionToken {
  const value = token.trim();
  if (!value || value.startsWith("'") || value.startsWith('"')) {
    return "none";
  }
  if (/^(?:(?:\d+)?(?:>|>>|>\|)|&(?:>|>>))$/u.test(value)) {
    return "separate-target";
  }
  if (/^(?:(?:\d+)?(?:>|>>|>\|)|&(?:>|>>)).+/u.test(value)) {
    return "attached-target";
  }
  return "none";
}

function extractShellInputRedirectionTarget(token: string): string | null {
  const value = token.trim();
  if (!value || value.startsWith("'") || value.startsWith('"')) {
    return null;
  }
  const match = value.match(/^(?:\d+)?<(?!<|>)(.+)$/u);
  return match?.[1] || null;
}

function normalizeWorkspacePathToken(token: string): string | null {
  const value = token.replace(/^['"]|['"]$/g, "");
  const assignmentMatch = value.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/u);
  if (!assignmentMatch) {
    return value;
  }
  const rhs = assignmentMatch[2]?.replace(/^['"]|['"]$/g, "") || "";
  if (!rhs) {
    return null;
  }
  if (
    rhs.startsWith("./") ||
    rhs.startsWith("../") ||
    rhs.startsWith("/") ||
    rhs.includes("/") ||
    /\.(py|js|mjs|cjs|sh|json|yaml|yml|md|txt|toml|cfg|ini)$/iu.test(rhs)
  ) {
    return rhs;
  }
  return null;
}

function looksLikeWorkspacePath(value: string): boolean {
  if (/^[a-z]+:\/\//iu.test(value)) {
    return false;
  }
  return (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("/") ||
    value.includes("/") ||
    /\.(py|js|mjs|cjs|sh|json|yaml|yml|md|txt|toml|cfg|ini)$/iu.test(value)
  );
}

function formatArtifactPath(filePath: string, workspaceRoot?: string): string {
  if (workspaceRoot && isPathInsideOrEqual(filePath, workspaceRoot)) {
    return path.relative(workspaceRoot, filePath).replace(/\\/g, "/");
  }
  return filePath.replace(/\\/g, "/");
}

async function collectPythonVerificationSurfacePaths(params: {
  command: string;
  cwd: string;
  workspaceRoot: string;
  scriptPath?: string;
}): Promise<string[]> {
  const candidates = dedupeStrings([
    ...(params.scriptPath ? [params.scriptPath] : []),
    ...extractWorkspacePathsFromCommand(params.command, params.cwd, params.workspaceRoot)
  ]).filter((filePath) => path.extname(filePath).toLowerCase() === ".py");
  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      existing.push(candidate);
    }
  }
  return dedupeStrings(existing);
}

async function detectPythonIssueAcrossSurfaces(
  scriptPaths: string[],
  detector: (scriptPath?: string) => Promise<string | undefined>
): Promise<string | undefined> {
  for (const scriptPath of scriptPaths) {
    const issue = await detector(scriptPath);
    if (issue) {
      return issue;
    }
  }
  return undefined;
}

function summarizeVerification(
  command: string,
  cwd: string,
  obs: AciObservation,
  localization: LocalizationResult
): VerifyReport {
  const stdoutExcerpt = trimBlock(obs.stdout || "", 1200);
  const stderrExcerpt = trimBlock(obs.stderr || "", 1200);
  if (obs.status === "ok") {
    return {
      status: "pass",
      command,
      cwd,
      exit_code: obs.exit_code ?? 0,
      next_action: "accept",
      stdout_excerpt: stdoutExcerpt || undefined,
      stderr_excerpt: stderrExcerpt || undefined,
      summary: `Local verification passed via ${command}.`
    };
  }

  const failureType = classifyVerificationFailure(obs, localization);
  const policyRuleId =
    failureType === "policy" ? obs.policy?.rule_id || extractPolicyRuleId(stderrExcerpt || stdoutExcerpt || "") : undefined;
  return {
    status: "fail",
    command,
    cwd,
    exit_code: obs.exit_code ?? 1,
    failure_type: failureType,
    policy_rule_id: policyRuleId,
    policy_reason: failureType === "policy" ? obs.policy?.reason : undefined,
    next_action:
      failureType === "environment"
        ? "stop_for_environment"
        : failureType === "policy"
          ? "stop_for_policy"
        : failureType === "localization"
          ? "relocalize"
          : "retry_patch",
    stdout_excerpt: stdoutExcerpt || undefined,
    stderr_excerpt: stderrExcerpt || undefined,
    summary: buildVerificationFailureSummary(command, failureType, stderrExcerpt || stdoutExcerpt || "unknown error")
  };
}

async function detectPythonUndefinedUppercaseReferences(scriptPath?: string): Promise<string | undefined> {
  if (!scriptPath || path.extname(scriptPath) !== ".py") {
    return undefined;
  }

  let source: string;
  try {
    source = await fs.readFile(scriptPath, "utf8");
  } catch {
    return undefined;
  }

  const lines = source.split(/\r?\n/u);
  const defined = new Set<string>([
    "False",
    "None",
    "True",
    "__name__",
    "__file__"
  ]);
  const used = new Map<string, number>();
  const stripState: PythonLineStripState = {};

  for (let index = 0; index < lines.length; index += 1) {
    const code = stripPythonLineStringsAndComment(lines[index], stripState);

    const assignment = code.match(/^\s*([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=/u);
    if (assignment) {
      defined.add(assignment[1]);
    }

    for (const importMatch of code.matchAll(/\bfrom\s+[\w.]+\s+import\s+(.+)$/gu)) {
      for (const importedName of importMatch[1].split(",")) {
        const name = importedName.trim().split(/\s+as\s+/u).pop()?.trim();
        if (name && /^[A-Z][A-Z0-9_]{2,}$/u.test(name)) {
          defined.add(name);
        }
      }
    }

    for (const nameMatch of code.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/gu)) {
      const name = nameMatch[0];
      const previous = code[nameMatch.index - 1];
      if (previous === ".") {
        continue;
      }
      if (isGlobalsGuardedUppercaseReference(lines[index], name)) {
        continue;
      }
      if (!used.has(name)) {
        used.set(name, index + 1);
      }
    }
  }

  const missing = [...used.entries()]
    .filter(([name]) => !defined.has(name))
    .slice(0, 8);
  if (missing.length === 0) {
    return undefined;
  }

  const rendered = missing.map(([name, line]) => `${name} at ${path.basename(scriptPath)}:${line}`).join(", ");
  return `Python source references uppercase constant(s) that are never defined or imported: ${rendered}. Define these constants before module-level use or load them from config.`;
}

async function detectPythonMissingConcreteConditionWorkerSurface(
  scriptPath?: string
): Promise<string | undefined> {
  if (!scriptPath || path.extname(scriptPath) !== ".py") {
    return undefined;
  }

  let source: string;
  try {
    source = await fs.readFile(scriptPath, "utf8");
  } catch {
    return undefined;
  }

  const workerDiscoveryNames = [
    "run_locked_condition",
    "run_single_locked_condition",
    "execute_single_locked_condition",
    "run_condition_worker",
    "train_and_evaluate_condition",
    "train_evaluate_condition",
    "run_condition"
  ];

  if (
    source.includes("_autolabos_single_condition_execution_helper_marker") &&
    source.includes("No generated single-condition execution worker was available after materialization.")
  ) {
    const fallbackDelegateNames = [
      "execute_single_condition_run",
      "run_single_condition_model_execution",
      "execute_single_condition_model_execution",
      "run_condition_model_execution",
      "execute_condition_model_execution",
      "run_single_condition_training",
      "execute_single_condition_training",
      "execute_single_condition",
      "execute_condition_seed",
      "run_condition_seed",
      "execute_condition_training",
      "run_condition_training",
      "train_single_condition",
      "train_condition",
      "execute_condition_run",
      "run_condition_experiment",
      "execute_condition",
      "run_condition",
      "train_and_evaluate_condition"
    ];
    const definedDelegateNames = fallbackDelegateNames.filter((name) =>
      pythonSourceDefinesConcreteCallableCandidate(source, name)
    );
    if (definedDelegateNames.length === 0) {
      const helperIndex = source.indexOf("def run_single_condition(");
      const helperLine = helperIndex >= 0
        ? source.slice(0, helperIndex).split(/\r?\n/u).length
        : source.slice(0, source.indexOf("No generated single-condition execution worker was available after materialization.")).split(/\r?\n/u).length;
      return [
        "Generated Python runner has no concrete per-condition execution worker.",
        `The single-condition fallback helper at ${path.basename(scriptPath)}:${helperLine} can only record condition_execution failures because none of its delegate candidates are concrete workers.`,
        "Generate or preserve a real condition-level train/evaluate worker before handoff; do not satisfy local verification with a fallback helper that marks every planned run as failed."
      ].join(" ");
    }
  }

  if (
    source.includes("def execute_locked_condition_plan(") &&
    source.includes("def _find_condition_worker(") &&
    (source.includes("No real per-condition execution worker is registered") ||
      source.includes("worker_discovery"))
  ) {
    const definedWorkerNames = workerDiscoveryNames.filter((name) =>
      pythonSourceDefinesConcreteCallableCandidate(source, name)
    );
    if (definedWorkerNames.length > 0) {
      return undefined;
    }

    const resolverLine = source.slice(0, source.indexOf("def _find_condition_worker(")).split(/\r?\n/u).length;
    return [
      "Generated Python runner has no concrete per-condition execution worker.",
      `The condition-worker resolver at ${path.basename(scriptPath)}:${resolverLine} searches ${workerDiscoveryNames.join(", ")} but none of those workers are defined or imported.`,
      "Generate or preserve a real per-condition train/evaluate worker before handoff; do not satisfy local verification by recording all planned conditions as worker_discovery failures."
    ].join(" ");
  }

  if (
    source.includes("_autolabos_local_runner_entrypoint_marker") &&
    source.includes("No callable experiment entrypoint was available")
  ) {
    const bridgeCandidateNames = [
      "run_experiment",
      "execute_experiment",
      "orchestrate_experiment",
      "run_study",
      "execute_study",
      "orchestrate_study",
      "run_condition_sweep",
      "execute_condition_sweep",
      "run_condition_grid_study",
      "execute_experiment_loop",
      "run_workflow",
      "execute_workflow",
      "run_model_execution",
      "execute_model_execution",
      "orchestrate_model_execution",
      "run_model_execution_stage",
      "execute_model_execution_stage",
      "orchestrate_model_execution_stage",
      "execute_single_condition",
      "run_single_condition",
      "execute_condition_seed",
      "run_condition_seed",
      "execute_single_condition_seed",
      "run_single_condition_seed",
      "execute_condition_seed_run",
      "run_condition_seed_experiment",
      "run_single_condition_model_execution",
      "execute_single_condition_model_execution",
      "run_condition_model_execution",
      "execute_condition_model_execution",
      "execute_condition_model",
      "run_condition_model",
      "train_condition_model",
      "run_single_condition_training",
      "execute_single_condition_training",
      "train_single_condition",
      "train_condition",
      "run_condition_training",
      "execute_condition_training",
      "execute_condition",
      "run_condition",
      "train_and_evaluate_condition",
      "execute_condition_run",
      "run_condition_experiment"
    ];
    const definedBridgeCandidates = bridgeCandidateNames.filter((name) =>
      pythonSourceDefinesConcreteCallableCandidate(source, name)
    );
    const hasGenericBridgeCandidate = pythonSourceDefinesConcreteBridgeCallableCandidate(source);
    if (definedBridgeCandidates.length === 0 && !hasGenericBridgeCandidate) {
      const bridgeIndex = source.indexOf("No callable experiment entrypoint was available");
      const bridgeLine = bridgeIndex >= 0
        ? source.slice(0, bridgeIndex).split(/\r?\n/u).length
        : 1;
      return [
        "Generated Python runner has no concrete executable experiment entrypoint.",
        `The AutoLabOS CLI bridge at ${path.basename(scriptPath)}:${bridgeLine} can only emit a No callable experiment entrypoint failure because no high-level experiment runner or single-condition worker is defined.`,
        "Generate or preserve a real experiment orchestrator or condition-level train/evaluate callable before handoff; py_compile alone is not sufficient for runnable experiment evidence."
      ].join(" ");
    }
  }

  if (
    !source.includes("No condition-level execution callable was found") &&
    !source.includes("No condition level execution callable was found")
  ) {
    return undefined;
  }

  const callableResolverNames = [
    "run_locked_condition_study",
    "run_locked_comparison_study",
    "execute_locked_condition_study",
    "execute_locked_comparison",
    "run_comparison_workflow",
    "run_experiment_suite",
    "orchestrate_locked_condition_run",
    "orchestrate_locked_study",
    "run_condition_experiment",
    "run_single_condition_training",
    "execute_single_condition_training",
    "train_single_condition",
    "train_condition",
    "run_single_condition",
    "execute_condition",
    "train_and_evaluate_condition",
    "run_condition_worker",
    "run_condition_trial"
  ];
  const definedCallableNames = callableResolverNames.filter((name) =>
    pythonSourceDefinesConcreteCallableCandidate(source, name)
  );
  if (definedCallableNames.length > 0) {
    return undefined;
  }

  const resolverIndex = source.indexOf("def _run_execution_with_available_pipeline(");
  const resolverLine = resolverIndex >= 0
    ? source.slice(0, resolverIndex).split(/\r?\n/u).length
    : source.slice(0, source.indexOf("No condition-level execution callable was found")).split(/\r?\n/u).length;
  return [
    "Generated Python runner has no concrete per-condition execution worker.",
    `The execution resolver at ${path.basename(scriptPath)}:${resolverLine} reports that no condition-level execution callable was found while searching ${callableResolverNames.join(", ")}.`,
    "Generate or preserve a real condition-level train/evaluate callable before handoff; py_compile alone is not sufficient for runnable experiment evidence."
  ].join(" ");
}

function isGlobalsGuardedUppercaseReference(line: string, name: string): boolean {
  const escapedName = escapeRegex(name);
  return new RegExp(
    `\\b${escapedName}\\b\\s+if\\s+["']${escapedName}["']\\s+in\\s+globals\\s*\\(\\s*\\)\\s+else\\b`,
    "u"
  ).test(line);
}

type PythonLineStripState = {
  tripleQuote?: "'''" | "\"\"\"";
};

function stripPythonLineStringsAndComment(line: string, state: PythonLineStripState = {}): string {
  let stripped = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    if (state.tripleQuote) {
      if (line.startsWith(state.tripleQuote, index)) {
        stripped += " ".repeat(state.tripleQuote.length);
        index += state.tripleQuote.length - 1;
        state.tripleQuote = undefined;
        continue;
      }
      stripped += " ";
      continue;
    }

    const char = line[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      stripped += " ";
      continue;
    }
    if (char === "#") {
      break;
    }
    if (line.startsWith("'''", index) || line.startsWith("\"\"\"", index)) {
      const tripleQuote = line.slice(index, index + 3) as "'''" | "\"\"\"";
      stripped += " ".repeat(tripleQuote.length);
      index += tripleQuote.length - 1;
      state.tripleQuote = tripleQuote;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      stripped += " ";
      continue;
    }
    stripped += char;
  }
  return stripped;
}

interface PythonTopLevelFunctionDefinition {
  name: string;
  signature: string;
  startOffset: number;
  endOffset: number;
}

interface PythonCallShape {
  keywords: Set<string>;
  maxPositionalArgs: number;
}

export async function materializePublicPlannedConditionContractArtifact(input: {
  publicDir?: string;
  contract?: PlannedConditionImplementationContract;
}): Promise<{ repaired: boolean; artifactPath?: string; message?: string }> {
  if (!input.publicDir || !input.contract) {
    return { repaired: false };
  }

  const requiredMarkers = dedupeStrings(input.contract.required_condition_markers || []);
  const seedSchedule = (input.contract.seed_schedule || [])
    .map((seed) => Number(seed))
    .filter((seed) => Number.isInteger(seed));
  const requiredConditionCount = normalizeContractPositiveInteger(input.contract.required_condition_count);
  const requiredRunCount = normalizeContractPositiveInteger(input.contract.required_run_count);
  if (
    requiredMarkers.length === 0 &&
    seedSchedule.length === 0 &&
    requiredConditionCount === undefined &&
    requiredRunCount === undefined
  ) {
    return { repaired: false };
  }

  const artifactPath = path.join(input.publicDir, "locked_condition_contract.json");
  const payload = {
    version: 1,
    source: "approved_design_contract",
    required_condition_markers: requiredMarkers,
    baseline_condition_marker: input.contract.baseline_condition_marker || requiredMarkers[0] || null,
    required_condition_count: requiredConditionCount ?? requiredMarkers.length,
    seed_schedule: seedSchedule,
    required_run_count:
      requiredRunCount ??
      (requiredMarkers.length > 0 && seedSchedule.length > 0
        ? requiredMarkers.length * seedSchedule.length
        : null)
  };

  let previous = "";
  try {
    previous = await fs.readFile(artifactPath, "utf8");
  } catch {
    previous = "";
  }
  const next = `${JSON.stringify(payload, null, 2)}\n`;
  if (previous === next) {
    return { repaired: false, artifactPath };
  }

  await writeJsonFile(artifactPath, payload);
  return {
    repaired: true,
    artifactPath,
    message: `Materialized public planned condition contract artifact in ${path.basename(artifactPath)} before design validation.`
  };
}

export async function repairPublicPlannedConditionContractDocsSurface(input: {
  publicDir?: string;
  contract?: PlannedConditionImplementationContract;
}): Promise<{ repaired: boolean; artifactPaths: string[]; message?: string }> {
  if (!input.publicDir || !input.contract) {
    return { repaired: false, artifactPaths: [] };
  }

  const requiredRunCount = normalizeContractPositiveInteger(input.contract.required_run_count);
  const requiredConditionCount = normalizeContractPositiveInteger(input.contract.required_condition_count);
  const seedSchedule = (input.contract.seed_schedule || [])
    .map((seed) => Number(seed))
    .filter((seed) => Number.isInteger(seed));
  if (requiredRunCount === undefined && requiredConditionCount === undefined && seedSchedule.length === 0) {
    return { repaired: false, artifactPaths: [] };
  }

  const docNames = ["README.md", "README_study_report.md"];
  const artifactPaths: string[] = [];
  let repaired = false;
  for (const docName of docNames) {
    const docPath = path.join(input.publicDir, docName);
    let source: string;
    try {
      source = await fs.readFile(docPath, "utf8");
    } catch {
      continue;
    }
    artifactPaths.push(docPath);
    let nextSource = source;
    if (seedSchedule.length > 0) {
      nextSource = nextSource
        .replace(/(Seeds per condition:\s*)\d+/giu, `$1${seedSchedule.length}`)
        .replace(/(Each of the\s+)\d+(\s+conditions is executed for all\s+)\d+(\s+required seeds)/giu,
          (_match, prefix: string, middle: string, suffix: string) =>
            `${prefix}${requiredConditionCount ?? "approved"}${middle}${seedSchedule.length}${suffix}`
        )
        .replace(/(-\s*)\d+(\s+required seeds per condition\b)/giu, `$1${seedSchedule.length}$2`);
    }
    if (requiredRunCount !== undefined) {
      nextSource = nextSource
        .replace(/(Total runs:\s*)\d+/giu, `$1${requiredRunCount}`)
        .replace(/(\b)\d+(\s+conditions\s*[×x]\s*)\d+(\s+seeds\s*=\s*)\d+(\s+total runs\b)/giu,
          (_match, prefix: string, middleA: string, middleB: string, suffix: string) =>
            `${prefix}${requiredConditionCount ?? "approved"}${middleA}${seedSchedule.length || "approved"}${middleB}${requiredRunCount}${suffix}`
        )
        .replace(/(-\s*)\d+(\s+total runs\b)/giu, `$1${requiredRunCount}$2`);
    }

    const marker = "<!-- _autolabos_public_planned_contract_docs_marker -->";
    if (!nextSource.includes(marker)) {
      const contractLines = [
        "",
        marker,
        "## Approved Design Contract",
        requiredConditionCount !== undefined ? `- Required conditions: ${requiredConditionCount}` : undefined,
        seedSchedule.length > 0 ? `- Seeds per condition: ${seedSchedule.length}` : undefined,
        requiredRunCount !== undefined ? `- Total runs: ${requiredRunCount}` : undefined,
        ""
      ].filter((line): line is string => line !== undefined);
      nextSource = `${nextSource.replace(/\s*$/u, "\n")}${contractLines.join("\n")}`;
    }

    if (nextSource !== source) {
      await fs.writeFile(docPath, nextSource, "utf8");
      repaired = true;
    }
  }

  return {
    repaired,
    artifactPaths,
    message: repaired
      ? `Aligned public planned condition contract docs with the approved repeated-run count before design validation.`
      : undefined
  };
}

function normalizeContractPositiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

function classifyVerificationFailure(
  obs: AciObservation,
  localization: LocalizationResult
): ImplementFailureType {
  const text = `${obs.stderr || ""}\n${obs.stdout || ""}`.toLowerCase();
  if (obs.policy?.allowed === false || /policy blocked (?:test command|command)/u.test(text)) {
    return "policy";
  }
  if (
    /(command not found|no such file or directory|cannot find module|no module named|not recognized as an internal|enoent)/u
      .test(text)
  ) {
    return "environment";
  }
  if (localization.selected_files.length === 0 && localization.candidates.length === 0) {
    return "localization";
  }
  if (/(usage:|argument error|missing required)/u.test(text)) {
    return "spec";
  }
  return "implementation";
}

function buildVerificationFailureSummary(
  command: string,
  failureType: ImplementFailureType,
  detail: string
): string {
  return `Local verification failed via ${command} (${failureType}): ${oneLine(detail)}`;
}

function extractPolicyRuleId(text: string): string | undefined {
  return text.match(/rule=([a-z0-9_]+)/i)?.[1];
}

async function loadImplementTopicProbeComputeContract(input: {
  workspaceRoot: string;
  run: RunRecord;
  runDir: string;
  rawBrief?: string;
}): Promise<ImplementTopicProbeComputeContract | undefined> {
  const modeGuard = await resolveResearchRunModeGuard({
    workspaceRoot: input.workspaceRoot,
    runId: input.run.id,
    rawBrief: input.rawBrief,
    run: input.run
  });
  if (!modeGuard.valid || modeGuard.evidenceStage === "standard") {
    return undefined;
  }
  const contractSource = resolveTopicProbeComputeContractSource(
    modeGuard.evidenceStage
  );
  if (!contractSource) {
    return undefined;
  }
  const stage: TopicProbeComputeStage = contractSource.stage;
  const relativePath = contractSource.relativePath;
  let activeContractRaw: string;
  try {
    activeContractRaw = await fs.readFile(path.join(input.runDir, relativePath), "utf8");
  } catch {
    return undefined;
  }
  const activeValidation = validateActiveTopicProbeContract(
    activeContractRaw,
    contractSource.requireCurrentRunId ? { expectedRunId: input.run.id } : {}
  );
  if (!activeValidation.valid || !activeValidation.contract) {
    return undefined;
  }
  const activeContract = activeValidation.contract;
  const budgetContract = buildTopicProbeComputeBudgetContract({
    runId: input.run.id,
    stage,
    activeTopicProbeContractSha256: activeContract.content_sha256,
    localBudget: activeContract.local_budget,
    briefComputeBudgetCeiling:
      activeContract.brief_compute_budget_ceiling,
    limits: activeContract.compute_budget,
    generatedAt: activeContract.generated_at
  });
  return {
    stage,
    active_contract_content_sha256: activeContract.content_sha256,
    active_limit: budgetContract.active_limit,
    requested_gpu_count: {
      type: "integer",
      minimum: 0,
      maximum: budgetContract.active_limit.max_concurrent_gpus
    },
    compute_usage_schema: TOPIC_PROBE_COMPUTE_USAGE_SCHEMA
  };
}

function formatTopicProbeComputePromptBlock(
  contract?: ImplementTopicProbeComputeContract
): string[] {
  if (!contract) {
    return [];
  }
  return [
    "## Topic-Probe Compute Contract",
    `- Active stage: ${contract.stage}`,
    `- Active stage limit: ${JSON.stringify(contract.active_limit)}`,
    `- Exact metrics.compute_usage JSON Schema: ${JSON.stringify(contract.compute_usage_schema)}`,
    "- metrics.compute_usage must contain every required field and no additional fields.",
    "- gpu_execution requires actual_gpu_count > 0 and fresh_executed_trials > 0; cpu_execution requires actual_gpu_count = 0 and fresh_executed_trials > 0; cache_hit requires actual_gpu_count = 0, fresh_executed_trials = 0, and cached_trials > 0.",
    "- Return requested_gpu_count as the actual non-negative GPU count requested by run_command. It is a request declaration, not a copy of max_concurrent_gpus.",
    "- Do not hand off test_command for topic-probe execution; run_experiments performs no unledgered pre-execution command.",
    ""
  ];
}

function formatEnvironmentSnapshotBlock(snapshot?: EnvironmentSnapshot): string[] {
  return [
    "## Execution Environment",
    `- Python: ${snapshot?.python_version || "not found"}`,
    `- GPU: ${snapshot?.gpu_available === true ? "available" : "not available"}`,
    `- Disk: ${snapshot?.available_disk_mb != null ? `${snapshot.available_disk_mb} MB free` : "unknown"}`,
    `- Working dir: ${snapshot?.working_directory || process.cwd()}`,
    ""
  ];
}

function dedupeStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function hasStructuredLlmClient(
  llm: { complete?: unknown } | undefined
): llm is { complete: (...args: unknown[]) => Promise<unknown> } {
  return typeof llm?.complete === "function";
}
