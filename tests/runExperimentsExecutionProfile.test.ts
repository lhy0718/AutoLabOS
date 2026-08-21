import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, utimes, writeFile } from "node:fs/promises";

import { InMemoryEventStream } from "../src/core/events.js";
import { MockLLMClient } from "../src/core/llm/client.js";
import { RunContextMemory } from "../src/core/memory/runContextMemory.js";
import { createRunExperimentsNode } from "../src/core/nodes/runExperiments.js";
import { FailureMemory, buildErrorFingerprint } from "../src/core/experiments/failureMemory.js";
import { buildPublicSectionDir } from "../src/core/publicArtifacts.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import { EXPERIMENT_GOVERNANCE_CONTRACT_KEY } from "../src/core/experimentGovernance.js";
import { RunRecord } from "../src/types.js";
import {
  type ActiveTopicProbeContract
} from "../src/core/activeTopicProbeContract.js";
import {
  TOPIC_PROBE_DECISION_RELATIVE_PATH,
  TOPIC_PROBE_PORTFOLIO_RELATIVE_PATH
} from "../src/core/topicProbeOutcomeArtifacts.js";
import { buildTopicProbeLineageFixture } from "./support/topicProbePortfolioFixture.js";
import {
  buildEvidenceAdequacyContract,
  EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH,
  EVIDENCE_ADEQUACY_METRICS_FIELD,
  type EvidenceAdequacyContractV2
} from "../src/core/analysis/evidenceAdequacy.js";
import { hashCanonical } from "../src/core/canonicalHash.js";

vi.mock("../src/core/runs/topicProbeExecutionAuthorizationGate.js", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../src/core/runs/topicProbeExecutionAuthorizationGate.js")
  >();
  return {
    ...original,
    loadTopicProbeExecutionAuthorizationGate: vi.fn(async ({
      runId,
      expectedResearchCycle
    }: {
      runId: string;
      expectedResearchCycle: number;
    }) => ({
      schema_version: 1 as const,
      artifact_kind: "topic_probe_execution_authorization_gate" as const,
      run_id: runId,
      research_cycle: expectedResearchCycle,
      status: "authorized" as const,
      effective_execution_authorized: true,
      authorization: {
        status: "authorized" as const,
        trusted: true,
        authorized: true,
        base_funnel_authorized: true,
        candidate_prior_search_authorized: true,
        estimator_authorized: true,
        required_candidate_ids: ["candidate_reference_1"],
        covered_candidate_ids: ["candidate_reference_1"],
        reason_codes: []
      },
      content_sha256: "0".repeat(64)
    }))
  };
});

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_DOCKER_SECRET_FILE = process.env.AUTOLABOS_DOCKER_SECRET_FILE;
const ORIGINAL_DOCKER_IMAGE = process.env.AUTOLABOS_DOCKER_IMAGE;

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  if (ORIGINAL_DOCKER_SECRET_FILE === undefined) {
    delete process.env.AUTOLABOS_DOCKER_SECRET_FILE;
  } else {
    process.env.AUTOLABOS_DOCKER_SECRET_FILE = ORIGINAL_DOCKER_SECRET_FILE;
  }
  if (ORIGINAL_DOCKER_IMAGE === undefined) {
    delete process.env.AUTOLABOS_DOCKER_IMAGE;
  } else {
    process.env.AUTOLABOS_DOCKER_IMAGE = ORIGINAL_DOCKER_IMAGE;
  }
});

function makeRun(runId: string): RunRecord {
  return {
    version: 3,
    workflowVersion: 3,
    id: runId,
    title: "Execution profile test",
    topic: "execution profile handling",
    constraints: [],
    objectiveMetric: "accuracy at least 0.9",
    status: "running",
    currentNode: "run_experiments",
    latestSummary: undefined,
    nodeThreads: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    graph: {
      ...createDefaultGraphState(),
      currentNode: "run_experiments"
    },
    memoryRefs: {
      runContextPath: `.autolabos/runs/${runId}/memory/run_context.json`,
      longTermPath: `.autolabos/runs/${runId}/memory/long_term.jsonl`,
      episodePath: `.autolabos/runs/${runId}/memory/episodes.jsonl`
    }
  };
}

async function executeMeaningPreservationFixture(input: {
  runId: string;
  metrics: Record<string, unknown>;
  objectiveMetric?: string;
  portfolio?: Record<string, unknown>;
  comparisonContract?: Record<string, unknown>;
  experimentContract?: Record<string, unknown>;
  rawConditionEvidenceRows?: Array<Record<string, unknown>>;
  briefRaw?: string;
  activeTopicProbeContract?: ActiveTopicProbeContract;
  commandDurationMs?: number;
  requestedGpuCount?: number | null;
  testCommand?: string;
  environmentGpuAvailable?: boolean;
}): Promise<{
  result: Awaited<ReturnType<ReturnType<typeof createRunExperimentsNode>["execute"]>>;
  metrics: Record<string, any>;
  runDir: string;
  runCommandCalls: string[];
  runTestCalls: string[];
}> {
  const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-meaning-preservation-"));
  process.chdir(root);
  const run = makeRun(input.runId);
  run.objectiveMetric = input.objectiveMetric || "quality_index >= 0";
  const runDir = path.join(root, ".autolabos", "runs", run.id);
  await mkdir(path.join(runDir, "memory"), { recursive: true });
  let topicEvidenceContract: EvidenceAdequacyContractV2 | undefined;
  if (input.activeTopicProbeContract) {
    const panelDir = path.join(runDir, "design_experiments_panel");
    await mkdir(panelDir, { recursive: true });
    const lineage = buildTopicProbeLineageFixture({
      runId: input.runId,
      researchCycle: input.activeTopicProbeContract.research_cycle,
      generatedAt: input.activeTopicProbeContract.generated_at,
      computeBudgetLimits: input.activeTopicProbeContract.compute_budget
    });
    if (
      lineage.activeContract.content_sha256
        !== input.activeTopicProbeContract.content_sha256
    ) {
      throw new Error("topic_probe_execution_fixture_contract_mismatch");
    }
    const portfolioPath = path.join(
      runDir,
      TOPIC_PROBE_PORTFOLIO_RELATIVE_PATH
    );
    await mkdir(path.dirname(portfolioPath), { recursive: true });
    await writeFile(
      portfolioPath,
      `${JSON.stringify(lineage.portfolio, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(runDir, TOPIC_PROBE_DECISION_RELATIVE_PATH),
      `${JSON.stringify(lineage.decision, null, 2)}\n`,
      "utf8"
    );
    await writeFile(
      path.join(panelDir, "active_topic_probe_contract.json"),
      `${JSON.stringify(input.activeTopicProbeContract, null, 2)}\n`,
      "utf8"
    );
    topicEvidenceContract = buildEvidenceAdequacyContract({
      primaryComparisonId: "comparison-primary-reference",
      designSource: {
        kind: "estimator_protocol",
        contentSha256: hashCanonical({ fixture: "generic_estimator_protocol" })
      },
      independentUnit: {
        key: "source item",
        analysisUnit: "paired outcome"
      },
      plannedIndependentCoverage: {
        mode: "sampled",
        targetUniqueUnits: 1,
        targetDenominatorPerArm: 1
      },
      requiredContrast: {
        arms: ["reference", "intervention"],
        paired: true,
        requiredCompletePairs: 1
      },
      uncertaintyRequirement: {
        mode: "required",
        allowedMethods: ["exact_paired"],
        confidenceLevel: 0.95,
        decisionRule: "directed_interval_bound_meets_effect_criterion"
      },
      effectResolution: {
        scale: "mean",
        minimumResolvableEffect: 1
      },
      executionBudget: {
        applicable: false,
        notApplicableRationale: "Compute governance is tested by a separate locked contract."
      }
    });
    await writeFile(
      path.join(runDir, EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH),
      `${JSON.stringify(topicEvidenceContract, null, 2)}\n`,
      "utf8"
    );
  }
  if (input.portfolio) {
    await writeFile(
      path.join(runDir, "experiment_portfolio.json"),
      JSON.stringify(input.portfolio, null, 2),
      "utf8"
    );
  }
  const experimentContract = input.experimentContract
    || (topicEvidenceContract
      ? {
          ...buildExperimentContractV2Fixture({
            runId: input.runId,
            metricId: "quality_index"
          }),
          results_plan: {
            ...buildExperimentContractV2Fixture({
              runId: input.runId,
              metricId: "quality_index"
            }).results_plan,
            minimum_series_count: 2,
            minimum_comparison_count: 1,
            required_series: [
              { id: "series-reference", role: "baseline" },
              { id: "series-primary", role: "primary" }
            ],
            required_comparisons: [
              {
                id: topicEvidenceContract.primary_comparison_id,
                subject_series_id: "series-primary",
                reference_series_id: "series-reference",
                metric_id: "quality_index",
                scope: { partition: "validation" }
              }
            ],
            primary_comparison_id: topicEvidenceContract.primary_comparison_id
          }
        }
      : undefined);
  if (experimentContract) {
    await writeFile(
      path.join(runDir, "experiment_contract.json"),
      JSON.stringify(experimentContract, null, 2),
      "utf8"
    );
  }

  const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
  await runContext.put("implement_experiments.run_command", "python3 run_configured_experiment.py");
  await runContext.put("implement_experiments.cwd", root);
  await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);
  if (input.activeTopicProbeContract && input.requestedGpuCount !== null) {
    await runContext.put(
      "implement_experiments.requested_gpu_count",
      input.requestedGpuCount ?? 1
    );
  }
  if (input.testCommand) {
    await runContext.put("implement_experiments.test_command", input.testCommand);
  }
  if (input.environmentGpuAvailable !== undefined) {
    await runContext.put("implement_experiments.environment_snapshot", {
      gpu_available: input.environmentGpuAvailable
    });
  }
  if (input.comparisonContract) {
    await runContext.put(EXPERIMENT_GOVERNANCE_CONTRACT_KEY, input.comparisonContract);
  }
  if (input.briefRaw) {
    await runContext.put("run_brief.raw", input.briefRaw);
  }
  const runCommandCalls: string[] = [];
  const runTestCalls: string[] = [];
  const eventStream = new InMemoryEventStream();
  const node = createRunExperimentsNode({
    config: {} as any,
    executionProfile: "local",
    runStore: {} as any,
    eventStream,
    llm: new MockLLMClient(),
    experimentLlm: new MockLLMClient(),
    pdfTextLlm: new MockLLMClient(),
    codex: {} as any,
    aci: {
      runCommand: async (command: string) => {
        runCommandCalls.push(command);
        if (input.rawConditionEvidenceRows) {
          await writeFile(
            path.join(runDir, "raw_condition_evidence.jsonl"),
            `${input.rawConditionEvidenceRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
            "utf8"
          );
        }
        const metrics = {
          ...input.metrics,
          ...(topicEvidenceContract
            && input.metrics[EVIDENCE_ADEQUACY_METRICS_FIELD] === undefined
            ? {
                [EVIDENCE_ADEQUACY_METRICS_FIELD]: {
                  schema: "autolabos.evidence_adequacy",
                  version: 2,
                  kind: "evidence_adequacy_execution_evidence",
                  contract_sha256: topicEvidenceContract.content_sha256,
                  primary_comparison_id: topicEvidenceContract.primary_comparison_id,
                  observed_population_manifest_sha256: null,
                  unique_execution_ids: ["execution_reference", "execution_intervention"],
                  observed_independent_unit_ids: ["source_1"],
                  observed_denominator_by_arm: {
                    reference: 1,
                    intervention: 1
                  },
                  observed_pair_coverage: {
                    complete_pair_ids: ["pair_1"],
                    incomplete_pair_ids: []
                  },
                  observed_uncertainty_methods: ["exact_paired"],
                  execution_budget_measurements: {},
                  primary_evidence_refs: ["metrics.json#results_artifact"],
                  auxiliary_evidence_refs: [],
                  deterministic_oracle_evidence_refs: []
                }
              }
            : {})
        };
        await writeFile(path.join(runDir, "metrics.json"), JSON.stringify(metrics, null, 2), "utf8");
        return {
          status: "ok" as const,
          stdout: "metrics written",
          stderr: "",
          exit_code: 0,
          duration_ms: input.commandDurationMs ?? 10
        };
      },
      runTests: async (command: string) => {
        runTestCalls.push(command);
        return { status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 };
      }
    } as any,
    semanticScholar: {} as any,
    openAlex: {} as any,
    crossref: {} as any,
    arxiv: {} as any,
    responsesPdfAnalysis: {} as any
  });

  const result = await node.execute({ run, graph: run.graph });
  let persistedMetrics: Record<string, any> = {};
  try {
    persistedMetrics = JSON.parse(
      await readFile(path.join(runDir, "metrics.json"), "utf8")
    ) as Record<string, any>;
  } catch {
    // Preflight failures intentionally produce no metrics artifact.
  }
  return { result, metrics: persistedMetrics, runDir, runCommandCalls, runTestCalls };
}

function buildExplicitResultsV2Fixture(input: {
  primaryValue: number;
  metricId?: string;
  direction?: "higher_better" | "lower_better";
  referenceValue?: number;
  comparisonDelta?: number;
  primaryRole?: "primary" | "comparator";
  scope?: Record<string, string | number | boolean | null>;
}): Record<string, unknown> {
  const metricId = input.metricId || "outcome_measure";
  const scope = input.scope || { partition: "validation" };
  const primaryObservationId = "observation-primary";
  const referenceObservationId = "observation-reference";
  const hasReference = input.referenceValue !== undefined;
  const hasComparison = hasReference && input.comparisonDelta !== undefined;
  return {
    results_artifact: {
      schema_version: "2.0",
      metrics: [
        {
          id: metricId,
          label: "Outcome measure",
          direction: input.direction || "higher_better",
          unit: "unitless"
        }
      ],
      series: [
        ...(hasReference
          ? [{ id: "series-reference", label: "Reference series", role: "baseline", dimensions: {} }]
          : []),
        {
          id: "series-primary",
          label: "Primary series",
          role: input.primaryRole || "primary",
          dimensions: {}
        }
      ],
      observations: [
        ...(hasReference
          ? [{
              id: referenceObservationId,
              series_id: "series-reference",
              metric_id: metricId,
              scope,
              value: input.referenceValue
            }]
          : []),
        {
          id: primaryObservationId,
          series_id: "series-primary",
          metric_id: metricId,
          scope,
          value: input.primaryValue
        }
      ],
      comparisons: hasComparison
        ? [{
            id: "comparison-primary-reference",
            subject_observation_id: primaryObservationId,
            reference_observation_id: referenceObservationId,
            delta: input.comparisonDelta
          }]
        : []
    },
    results_selection: {
      metric_id: metricId,
      primary_observation_id: primaryObservationId,
      ...(hasComparison ? { primary_comparison_id: "comparison-primary-reference" } : {})
    }
  };
}

function buildExperimentContractV2Fixture(input: {
  runId: string;
  metricId?: string;
  direction?: "higher_better" | "lower_better";
}): Record<string, unknown> {
  const metricId = input.metricId || "outcome_measure";
  return {
    version: 2,
    run_id: input.runId,
    created_at: new Date().toISOString(),
    hypothesis: "The declared intervention changes the recorded outcome.",
    causal_mechanism: "The intervention changes only the measured execution path.",
    single_change: "Enable the declared intervention.",
    confounded: false,
    expected_metric_effect: "A measurable change in the explicit outcome metric.",
    abort_condition: "Abort when execution evidence is incomplete.",
    keep_or_discard_rule: "Keep only complete observations that satisfy the explicit results plan.",
    results_plan: {
      schema_version: "2.0",
      required_metrics: [
        {
          id: metricId,
          label: "Outcome measure",
          direction: input.direction || "higher_better",
          unit: "unitless"
        }
      ],
      minimum_series_count: 1,
      minimum_comparison_count: 0
    }
  };
}

describe("run_experiments execution profile behavior", () => {
  it("blocks same-node execution when failure memory marks run_experiments do-not-retry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-profile-"));
    process.chdir(root);
    const run = makeRun("run-do-not-retry-start");
    run.graph.retryCounters.run_experiments = 1;
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const errorMessage =
      "Experiment metrics contract failed: Condition summary accuracy is inconsistent with correct/total counts.";
    await FailureMemory.forRun(run.id).append({
      run_id: run.id,
      node_id: "run_experiments",
      attempt: 1,
      failure_class: "structural",
      error_fingerprint: buildErrorFingerprint(errorMessage),
      error_message: errorMessage,
      do_not_retry: true,
      do_not_retry_reason: "Structural execution failure."
    });

    const aci = {
      runCommand: vi.fn(),
      runTests: vi.fn()
    };

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: aci as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("do-not-retry");
    expect(aci.runCommand).not.toHaveBeenCalled();
    expect(aci.runTests).not.toHaveBeenCalled();
  });

  it("allows run_experiments after a newer upstream implementation repair", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-profile-"));
    process.chdir(root);
    const run = makeRun("run-upstream-repair-after-failure-memory");
    run.graph.retryCounters.run_experiments = 2;
    run.graph.nodeStates.implement_experiments.status = "completed";
    run.graph.nodeStates.implement_experiments.updatedAt = "2026-04-07T00:10:00.000Z";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await writeFile(
      path.join(runDir, "failure_memory.jsonl"),
      JSON.stringify({
        failure_id: "failure-before-upstream-repair",
        run_id: run.id,
        node_id: "run_experiments",
        attempt: 1,
        timestamp: "2026-04-07T00:00:00.000Z",
        failure_class: "structural",
        error_fingerprint: "structural execution failure",
        error_message: "Experiment metrics contract failed.",
        do_not_retry: true,
        do_not_retry_reason: "Structural execution failure."
      }) + "\n",
      "utf8"
    );

    const aci = {
      runCommand: vi.fn(),
      runTests: vi.fn()
    };

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "plan_only",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: aci as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "plan_only_mode"
    });
    expect(aci.runCommand).not.toHaveBeenCalled();
    expect(aci.runTests).not.toHaveBeenCalled();
  });

  it("allows run_experiments after a newer harness repair", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-harness-repair-after-failure-memory-"));
    process.chdir(root);
    const run = makeRun("run-harness-repair-after-failure-memory");
    run.graph.retryCounters.run_experiments = 2;
    run.graph.nodeStates.implement_experiments.status = "completed";
    run.graph.nodeStates.implement_experiments.updatedAt = "1970-01-01T00:00:00.000Z";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await writeFile(
      path.join(runDir, "failure_memory.jsonl"),
      JSON.stringify({
        failure_id: "failure-before-harness-repair",
        run_id: run.id,
        node_id: "run_experiments",
        attempt: 1,
        timestamp: "1970-01-01T00:00:00.000Z",
        failure_class: "structural",
        error_fingerprint: "structural execution failure",
        error_message: "Experiment metrics contract failed.",
        do_not_retry: true,
        do_not_retry_reason: "Structural execution failure."
      }) + "\n",
      "utf8"
    );

    const aci = {
      runCommand: vi.fn(),
      runTests: vi.fn()
    };

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "plan_only",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: aci as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "plan_only_mode"
    });
    expect(aci.runCommand).not.toHaveBeenCalled();
    expect(aci.runTests).not.toHaveBeenCalled();
  });

  it("skips code execution in plan_only mode and records a skipped verifier report", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-profile-"));
    process.chdir(root);
    const run = makeRun("run-plan-only");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const aci = {
      runCommand: vi.fn(),
      runTests: vi.fn()
    };

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "plan_only",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: aci as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "plan_only_mode"
    });
    expect(aci.runCommand).not.toHaveBeenCalled();
    expect(aci.runTests).not.toHaveBeenCalled();

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; summary: string };
    expect(verifierReport.status).toBe("skipped");
    expect(verifierReport.summary).toContain("plan_only");

    const intermediateArtifacts = JSON.parse(
      await readFile(path.join(runDir, "run_experiments", "intermediate_artifacts.json"), "utf8")
    ) as {
      summary: { present: number; missing_required: number };
      entries: Array<{ artifact_id: string; status: string; parse_status: string; relative_path: string }>;
    };
    expect(intermediateArtifacts.summary.present).toBeGreaterThanOrEqual(1);
    expect(intermediateArtifacts.summary.missing_required).toBe(0);
    expect(intermediateArtifacts.entries).toContainEqual(
      expect.objectContaining({
        artifact_id: "run_experiments_verify_report",
        relative_path: "run_experiments_verify_report.json",
        status: "present",
        parse_status: "parseable"
      })
    );
  });

  it("treats remote bootstrap requirements as metadata instead of a hard policy stop", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-bootstrap-contract-"));
    process.chdir(root);
    const run = makeRun("run-bootstrap-blocked");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    const publicDir = path.join(root, "outputs", "experiment");
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(publicDir, { recursive: true });
    await writeFile(
      path.join(publicDir, "bootstrap_contract.json"),
      JSON.stringify(
        {
          version: 1,
          requires_network: true,
          summary:
            "This run may fetch a public Hugging Face model/tokenizer on demand.",
          remediation: ["Prewarm the cache or allow network bootstrap."]
        },
        null,
        2
      ),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.public_dir", publicDir);

    const aci = {
      runCommand: vi.fn().mockResolvedValue({
        status: "error",
        stderr: "synthetic failure after bootstrap warning",
        exit_code: 1,
        duration_ms: 1
      }),
      runTests: vi.fn().mockResolvedValue({
        status: "error",
        stderr: "synthetic failure after bootstrap warning",
        exit_code: 1,
        duration_ms: 1
      })
    };

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: aci as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(String(result.error || "")).not.toContain("Offline execution cannot proceed");
    expect(aci.runCommand).not.toHaveBeenCalledWith(
      expect.stringContaining("Offline execution cannot proceed")
    );
  });

  it("passes overwrite intent to reusable public runners that expose an overwrite flag", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-reusable-output-"));
    process.chdir(root);
    const run = makeRun("run-reusable-output");
    run.objectiveMetric = "accuracy >= 0.9";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    const publicDir = path.join(root, "outputs", "public-runner");
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(publicDir, { recursive: true });

    const scriptPath = path.join(publicDir, "run_condition_sweep.py");
    await writeFile(
      scriptPath,
      [
        "import argparse",
        "parser = argparse.ArgumentParser()",
        "parser.add_argument('--output-dir')",
        "parser.add_argument('--metrics-path')",
        "parser.add_argument('--env-file')",
        "parser.add_argument('--overwrite-output', action='store_true')",
        "parser.parse_args()"
      ].join("\n"),
      "utf8"
    );
    await writeFile(path.join(publicDir, "package-lock.json"), "{}\n", "utf8");
    await writeFile(path.join(publicDir, "study_results.json"), JSON.stringify({ status: "previous" }), "utf8");
    const scopedSecret = path.join(tmpdir(), `autolabos-run-secret-${run.id}.env`);
    await writeFile(scopedSecret, "PROVIDER_KEY=test-only\n", "utf8");
    await chmod(scopedSecret, 0o600);
    process.env.AUTOLABOS_DOCKER_SECRET_FILE = scopedSecret;
    process.env.AUTOLABOS_DOCKER_IMAGE = `sha256:${"b".repeat(64)}`;

    const metricsPath = path.join(runDir, "metrics.json");
    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put(
      "implement_experiments.run_command",
      `python3 ${JSON.stringify(scriptPath)} --env-file /run/secrets/autolabos.env --output-dir ${JSON.stringify(publicDir)} --metrics-path ${JSON.stringify(metricsPath)}`
    );
    await runContext.put("implement_experiments.cwd", publicDir);
    await runContext.put("implement_experiments.public_dir", publicDir);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const aci = {
      runCommand: vi.fn(async (command: string) => {
        expect(command).toContain("--overwrite-output");
        await writeFile(
          metricsPath,
          JSON.stringify(
            {
              status: "completed",
              accuracy: 0.95,
              primary_metric: { name: "accuracy", value: 0.95, target: 0.9, met: true }
            },
            null,
            2
          ),
          "utf8"
        );
        return {
          status: "ok" as const,
          stdout: "runner completed",
          stderr: "",
          exit_code: 0,
          duration_ms: 10
        };
      }),
      runTests: vi.fn()
    };

    const node = createRunExperimentsNode({
      config: {
        experiments: {
          network_policy: "required",
          network_purpose: "remote_inference"
        }
      } as any,
      executionProfile: "docker",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: aci as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, JSON.stringify(result)).toBe("success");
    expect(aci.runCommand).toHaveBeenCalledTimes(1);
    expect(aci.runTests).not.toHaveBeenCalled();
    const envelope = JSON.parse(
      await readFile(path.join(runDir, "execution", "execution_envelope.json"), "utf8")
    ) as Record<string, any>;
    const receipt = JSON.parse(
      await readFile(path.join(runDir, "execution", "execution_receipt.json"), "utf8")
    ) as Record<string, any>;
    expect(envelope.input_artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "outputs/public-runner/run_condition_sweep.py" })
    ]));
    expect(envelope.dependency_artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "outputs/public-runner/package-lock.json" })
    ]));
    expect(envelope.devices).toEqual({
      policy: "cpu_only",
      requested_gpu_count: 0,
      visible_device_ids: []
    });
    expect(envelope.container_image).toBe(`sha256:${"b".repeat(64)}`);
    expect(envelope.secret_files).toEqual([{
      target_path: "/run/secrets/autolabos.env",
      required: true
    }]);
    expect(receipt).toMatchObject({
      status: "completed",
      enforcement: "compatibility",
      paper_grade_eligible: false,
      required_outputs_present: true
    });
    expect(receipt.output_artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: `.autolabos/runs/${run.id}/metrics.json`,
        required: true
      })
    ]));
    expect(JSON.stringify(envelope)).not.toContain(root);
    expect(JSON.stringify(envelope)).not.toContain(scopedSecret);
    expect(JSON.stringify(envelope)).not.toContain("test-only");
    expect(JSON.stringify(receipt)).not.toContain(root);
  });

  it("blocks long-running generated runners that lack progress or partial metrics artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-long-run-observability-"));
    process.chdir(root);
    const run = makeRun("run-long-run-observability");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    const publicDir = path.join(root, "outputs", "public-runner");
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(publicDir, { recursive: true });

    const scriptPath = path.join(publicDir, "run_condition_sweep.py");
    await writeFile(
      scriptPath,
      [
        "from pathlib import Path",
        "import json",
        "",
        "REQUIRED_RUN_COUNT = 12",
        "work_units_per_run = 48",
        "",
        "def run_condition():",
        "    parameter.requires_grad = True",
        "    objective.backward()",
        "",
        "def main():",
        "    Path(\"metrics.json\").write_text(json.dumps({\"status\": \"completed\"}), encoding=\"utf-8\")",
        "",
        "if __name__ == \"__main__\":",
        "    main()",
        ""
      ].join("\n"),
      "utf8"
    );

    const metricsPath = path.join(runDir, "metrics.json");
    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put(
      "implement_experiments.run_command",
      `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`
    );
    await runContext.put("implement_experiments.cwd", publicDir);
    await runContext.put("implement_experiments.public_dir", publicDir);
    await runContext.put("implement_experiments.script", scriptPath);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const aci = {
      runCommand: vi.fn(),
      runTests: vi.fn()
    };

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: aci as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(String(result.error)).toContain("no observable progress, heartbeat, or partial-metrics surface");
    expect(aci.runCommand).not.toHaveBeenCalled();

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "preflight_test"
    });
    expect(verifierReport.summary).toContain("required_run_count=12");
    expect(verifierReport.suggested_next_action).toContain("progress");
  });

  it("blocks long-running generated runners that declare but never enforce a timeout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-budget-enforcement-"));
    process.chdir(root);
    const run = makeRun("run-budget-enforcement");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    const publicDir = path.join(root, "outputs", "public-runner");
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(publicDir, { recursive: true });

    const scriptPath = path.join(publicDir, "run_condition_sweep.py");
    await writeFile(
      scriptPath,
      [
        "import argparse",
        "from pathlib import Path",
        "",
        "REQUIRED_RUN_COUNT = 12",
        "work_units_per_run = 48",
        "progress_path = Path('progress.jsonl')",
        "",
        "def execute_planned_work():",
        "    for _example in range(1000):",
        "        pass",
        "",
        "def main():",
        "    parser = argparse.ArgumentParser()",
        "    parser.add_argument('--timeout-sec', type=int, default=1800)",
        "    parser.parse_args()",
        "    execute_planned_work()",
        "",
        "if __name__ == '__main__':",
        "    main()",
        ""
      ].join("\n"),
      "utf8"
    );

    const metricsPath = path.join(runDir, "metrics.json");
    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", `python3 ${JSON.stringify(scriptPath)}`);
    await runContext.put("implement_experiments.cwd", publicDir);
    await runContext.put("implement_experiments.public_dir", publicDir);
    await runContext.put("implement_experiments.script", scriptPath);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const aci = { runCommand: vi.fn(), runTests: vi.fn() };
    const node = createRunExperimentsNode({
      config: { experiments: { timeout_sec: 1800 } } as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: aci as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(String(result.error)).toContain("no executable planned-work loop consumes a deadline");
    expect(aci.runCommand).not.toHaveBeenCalled();
    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "preflight_test" });
    expect(verifierReport.summary).toContain("timeout_sec=1800");
    expect(verifierReport.suggested_next_action).toContain("wall-clock deadline");

    await writeFile(
      scriptPath,
      (await readFile(scriptPath, "utf8")).replace(
        "    execute_planned_work()",
        "    runtime.assert_time_available('before_planned_run')\n    execute_planned_work()"
      ),
      "utf8"
    );
    aci.runCommand.mockResolvedValue({
      status: "error",
      stdout: "",
      stderr: "stopped after governed preflight",
      exit_code: 1,
      duration_ms: 1
    });

    const guardedResult = await node.execute({ run, graph: run.graph });

    expect(guardedResult.status).toBe("failure");
    expect(String(guardedResult.error)).not.toContain("no executable planned-work loop consumes a deadline");
    expect(aci.runCommand).toHaveBeenCalled();
  });

  it("does not promote objective metrics from stale public bundle outputs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-stale-public-metric-"));
    process.chdir(root);
    const run = makeRun("run-stale-public-metric");
    run.objectiveMetric = "accuracy >= 0.9";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    const publicDir = path.join(root, "outputs", "public-runner");
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(publicDir, { recursive: true });

    const staleMetricsPath = path.join(publicDir, "metrics.json");
    await writeFile(
      staleMetricsPath,
      JSON.stringify({ status: "completed", accuracy: 0.99, primary_metric_key: "accuracy" }, null, 2),
      "utf8"
    );
    const staleDate = new Date(Date.now() - 60_000);
    await utimes(staleMetricsPath, staleDate, staleDate);

    const metricsPath = path.join(runDir, "metrics.json");
    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.public_dir", publicDir);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);
    const eventStream = new InMemoryEventStream();

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream,
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            metricsPath,
            JSON.stringify({ status: "completed", completed_run_count: 1, required_run_count: 1 }, null, 2),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner completed",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    const metrics = JSON.parse(await readFile(metricsPath, "utf8")) as { accuracy?: number };
    expect(metrics.accuracy).toBeUndefined();
    expect(
      eventStream.history().some((event) =>
        String(event.payload.text || "").includes("Promoted objective metric accuracy=0.99")
      )
    ).toBe(false);
  });

  it("fails verification when an aggregate explicitly reports incomplete execution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-incomplete-comparator-"));
    process.chdir(root);
    const run = makeRun("run-incomplete-comparator");
    run.objectiveMetric = "outcome_measure";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);
    await runContext.put(EXPERIMENT_GOVERNANCE_CONTRACT_KEY, {
      version: 1,
      run_id: run.id,
      plan_id: "plan-incomplete-comparator",
      selected_hypothesis_ids: ["hypothesis-1"],
      objective_metric_name: run.objectiveMetric,
      baseline_first_required: true,
      baseline_candidate_ids: ["baseline"],
      comparison_mode: "baseline_first_locked",
      budget_profile: {
        mode: "single_run_locked",
        locked: true,
        timeout_sec: 7200
      },
      objective_profile: {
        source: "heuristic_fallback",
        raw: run.objectiveMetric,
        primaryMetric: "outcome_measure",
        preferredMetricKeys: ["outcome_measure"],
        direction: "maximize"
      },
      evaluator_contract_id: "eval-contract-incomplete-comparator",
      created_at: new Date().toISOString()
    });

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                success: true,
                ...buildExplicitResultsV2Fixture({
                  metricId: "outcome_measure",
                  primaryValue: 0.2
                }),
                study: {
                  aggregate: {
                    all_conditions_succeeded: false,
                    completed_condition_count: 1,
                    failed_condition_count: 3
                  }
                }
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "experiment command completed",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment metrics contract failed");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("Study aggregate reports incomplete execution");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
  });

  it("fails verification when training aggregates report incomplete execution without objective metrics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-training-aggregates-incomplete-"));
    process.chdir(root);
    const run = makeRun("run-training-aggregates-incomplete");
    run.objectiveMetric = "outcome_measure >= 0.01";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed_model_execution",
                selected_model_id: "local-fixture-model",
                evaluation_ready: false,
                training_aggregates: {
                  completed_run_count: 3,
                  required_run_count: 4,
                  completed_training_run_count: 3,
                  completed_condition_count: 0,
                  required_condition_count: 2,
                  failed_run_count: 1,
                  timed_out_run_count: 1,
                  evaluation_ready: false,
                  condition_execution_aggregates: [
                    {
                      condition_marker: "baseline_condition",
                      is_baseline: true,
                      run_count: 2,
                      completed_training_run_count: 2,
                      failed_run_count: 0,
                      status_counts: { completed_training: 2 }
                    },
                    {
                      condition_marker: "candidate_condition",
                      is_baseline: false,
                      run_count: 2,
                      completed_training_run_count: 1,
                      failed_run_count: 1,
                      status_counts: { completed_training: 1, timeout: 1 }
                    }
                  ]
                },
                run_records: [
                  {
                    condition_marker: "baseline_condition",
                    seed: 1,
                    status: "completed_training",
                    train_metrics: { train_loss: 0.5 },
                    task_metrics: {}
                  },
                  {
                    condition_marker: "baseline_condition",
                    seed: 2,
                    status: "completed_training",
                    train_metrics: { train_loss: 0.49 },
                    task_metrics: {}
                  },
                  {
                    condition_marker: "candidate_condition",
                    seed: 1,
                    status: "completed_training",
                    train_metrics: { train_loss: 0.48 },
                    task_metrics: {}
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner wrote training aggregate metrics without objective evaluation",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment run coverage incomplete: completed_run_count=3/4");
    expect(result.error).toContain("No required experiment conditions completed successfully (0/2)");
    expect(result.error).toContain("Experiment metrics report failed_run_count=1");
    expect(result.error).toContain("Experiment metrics report timed_out_run_count=1");
    expect(result.error).toContain("failure_count=1");
  });

  it("includes condition state failure reasons when objective metrics are missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-condition-state-failure-"));
    process.chdir(root);
    const run = makeRun("run-condition-state-failure");
    run.objectiveMetric = "outcome_measure >= 0.01";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: {
        complete: async () => ({
          text: JSON.stringify({
            primaryMetric: "outcome_measure",
            preferredMetricKeys: ["outcome_measure"],
            direction: "maximize",
            comparator: ">=",
            targetValue: 0.01,
            analysisFocus: [],
            paperEmphasis: [],
            assumptions: []
          }),
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }
        })
      } as any,
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed_model_execution",
                success: true,
                selected_model_id: "fixture-model-family",
                condition_states: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    error: "no usable normalized training texts",
                    failure_code: "RuntimeError",
                    failure_stage: "condition_execution"
                  },
                  {
                    condition_marker: "candidate_condition_a",
                    status: "failed",
                    error: "no usable normalized training texts",
                    failure_code: "RuntimeError",
                    failure_stage: "condition_execution"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner wrote condition state failures without objective evaluation",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain('Objective metric "outcome_measure" was not found in metrics.json');
    expect(result.error).toContain("condition_state_reasons=no usable normalized training texts:2");
    expect(result.error).toContain("condition_state_failure_stages=condition_execution:2");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("condition_state_reasons=no usable normalized training texts:2");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.summary).toContain("condition_state_reasons=no usable normalized training texts:2");
  });


  it("includes nested high-level result failures when objective metrics are missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-nested-result-failure-"));
    process.chdir(root);
    const run = makeRun("run-nested-result-failure");
    run.objectiveMetric = "outcome_measure >= 0.01";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: {
        complete: async () => ({
          text: JSON.stringify({
            primaryMetric: "outcome_measure",
            preferredMetricKeys: ["outcome_measure"],
            direction: "maximize",
            comparator: ">=",
            targetValue: 0.01,
            analysisFocus: [],
            paperEmphasis: [],
            assumptions: []
          }),
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }
        })
      } as any,
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                success: true,
                result: {
                  status: "dependency_blocked",
                  failures: [
                    {
                      failure_code: "dependency_preflight_failed",
                      error: "TypeError(\"preflight_model_dependencies() missing 1 required positional argument: 'runtime'\")",
                      traceback: [
                        "Traceback (most recent call last):",
                        "  File \"experiment.py\", line 10, in execute_model_execution_phase",
                        "    preflight_model_dependencies()",
                        "TypeError: preflight_model_dependencies() missing 1 required positional argument: 'runtime'"
                      ].join("\n")
                    }
                  ]
                }
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner wrote nested blocked result without objective evaluation",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain('Objective metric "outcome_measure" was not found in metrics.json');
    expect(result.error).toContain("nested_failures=dependency_preflight_failed");
    expect(result.error).toContain("missing 1 required positional argument");

    const feedback = await runContext.get<{ summary: string }>("implement_experiments.runner_feedback");
    expect(feedback?.summary).toContain("nested_failures=dependency_preflight_failed");
  });


  it("leads dependency-blocked metrics with failure code and loader diagnostics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-dependency-blocked-summary-"));
    process.chdir(root);
    const run = makeRun("run-dependency-blocked-summary");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: {
        complete: async () => ({
          text: JSON.stringify({
            primaryMetric: "outcome_measure",
            preferredMetricKeys: ["outcome_measure"],
            direction: "maximize",
            comparator: ">=",
            targetValue: 0.01,
            analysisFocus: [],
            paperEmphasis: [],
            assumptions: []
          }),
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }
        })
      } as any,
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          const diagnostics = {
            loader_failures: [
              {
                loader: "load_task_bundle",
                diagnostics: {
                  stage: "data_access",
                  task: "benchmark_task_a",
                  allow_dataset_download: false,
                  usable_count: 3,
                  required_count: 12
                },
                error: "DataAccessError('benchmark examples unavailable')"
              }
            ]
          };
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "dependency_blocked",
                success: false,
                failure_code: "data_dependency_unavailable",
                error: "RuntimeError(\"Experiment data bundle could not be materialized\")",
                diagnostics,
                failures: [
                  {
                    failure_code: "data_dependency_unavailable",
                    message: "benchmark examples unavailable",
                    diagnostics
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "error" as const,
            stdout: "",
            stderr: "",
            exit_code: 1,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment dependency blocked (data_dependency_unavailable)");
    expect(result.error).toContain("metrics_status=dependency_blocked");
    expect(result.error).toContain("failure_code=data_dependency_unavailable");
    expect(result.error).toContain("loader_diagnostics=loader=load_task_bundle,stage=data_access,task=benchmark_task_a,allow_dataset_download=false,usable_count=3,required_count=12");

    const feedback = await runContext.get<{
      summary: string;
      failure_code?: string;
      repair_target?: string;
      recommended_backtrack_node?: string;
      operator_action_required?: boolean;
    }>("implement_experiments.runner_feedback");
    expect(feedback?.summary).toContain("Experiment dependency blocked (data_dependency_unavailable)");
    expect(feedback?.summary).toContain("loader_diagnostics=loader=load_task_bundle");
    expect(feedback?.failure_code).toBe("data_dependency_unavailable");
    expect(feedback?.repair_target).toBe("implementation");
    expect(feedback?.recommended_backtrack_node).toBe("implement_experiments");
    expect(feedback?.operator_action_required).toBe(true);
  });

  it("includes condition traceback tails when failed metrics omit direct error messages", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-condition-traceback-failure-"));
    process.chdir(root);
    const run = makeRun("run-condition-traceback-failure");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const traceback = [
      "Traceback (most recent call last):",
      '  File "experiment.py", line 100, in run_model_execution_phase',
      '    raise RuntimeError("no condition execution helper is defined")',
      "RuntimeError: no condition execution helper is defined",
      ""
    ].join("\n");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: true,
                condition_states: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    failure_code: "model_execution_failed",
                    failure_traceback: traceback
                  },
                  {
                    condition_marker: "candidate_condition_a",
                    status: "failed",
                    failure_code: "model_execution_failed",
                    failure_traceback: traceback
                  }
                ],
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    failure_code: "model_execution_failed",
                    failure_traceback: traceback
                  },
                  {
                    condition_marker: "candidate_condition_a",
                    status: "failed",
                    failure_code: "model_execution_failed",
                    failure_traceback: traceback
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner wrote failed condition rows with tracebacks",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment metrics payload reports failed status");
    expect(result.error).toContain("condition_state_failure_codes=model_execution_failed:2");
    expect(result.error).toContain("condition_state_reasons=RuntimeError: no condition execution helper is defined:2");
    expect(result.error).toContain("condition_result_reasons=RuntimeError: no condition execution helper is defined:2");
  });

  it("fails verification when planned brief conditions are under-executed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-under-executed-conditions-"));
    process.chdir(root);
    const run = makeRun("run-under-executed-conditions");
    run.objectiveMetric =
      "Primary metric: mean zero-shot accuracy. Meaningful improvement: at least +1.0 percentage point over the tuned baseline.";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);
    await runContext.put(
      "run_brief.raw",
      [
        "# Research Brief",
        "## Minimum Acceptable Evidence",
        "- All planned conditions must execute successfully and report bootstrap confidence intervals.",
        "## Minimum Experiment Plan",
        "- one named tuned baseline run",
        "- three alternative recipe conditions"
      ].join("\n")
    );
    await runContext.put(EXPERIMENT_GOVERNANCE_CONTRACT_KEY, {
      version: 1,
      run_id: run.id,
      plan_id: "plan-under-executed-conditions",
      selected_hypothesis_ids: ["hypothesis-1"],
      objective_metric_name: run.objectiveMetric,
      baseline_first_required: true,
      baseline_candidate_ids: ["standard_configured_baseline"],
      comparison_mode: "baseline_first_locked",
      budget_profile: {
        mode: "single_run_locked",
        locked: true,
        timeout_sec: 7200
      },
      objective_profile: {
        source: "heuristic_fallback",
        raw: run.objectiveMetric,
        primaryMetric: "outcome_measure",
        preferredMetricKeys: ["outcome_measure"],
        direction: "maximize",
        comparator: ">=",
        targetValue: 0.01
      },
      evaluator_contract_id: "eval-contract-under-executed-conditions",
      created_at: new Date().toISOString()
    });

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                primary_metric: {
                  name: "outcome_measure",
                  value: 0.012,
                  target: 0.01,
                  met: true
                },
                conditions: [
                  {
                    name: "base_unmodified",
                    condition_type: "baseline_unmodified_checkpoint",
                    evaluation: { mean_zero_shot_accuracy: 0.4 }
                  },
                  {
                    name: "candidate_condition_a",
                    condition_type: "parameterized_method",
                    evaluation: { mean_zero_shot_accuracy: 0.412 }
                  },
                  {
                    name: "candidate_condition_b",
                    condition_type: "parameterized_method",
                    evaluation: { mean_zero_shot_accuracy: 0.411 }
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "experiment command completed",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment metrics contract failed");
    expect(result.error).toContain("Planned condition coverage incomplete");
    expect(result.error).toContain("observed 2 successful tuned condition");
    expect(result.error).toContain("requires 4");
  });

  it("fails verification when successful metrics expand the planned condition and seed contract", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-expanded-condition-contract-"));
    process.chdir(root);
    const run = makeRun("run-expanded-condition-contract");
    run.objectiveMetric = "accuracy >= 0.9";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);
    await runContext.put(
      "run_brief.raw",
      [
        "# Research Brief",
        "## Constraints",
        "- Seed: 7 for the primary condition sweep.",
        "- Condition grid: width in `{1, 2}` x regularization in `{0.0, 0.5}`.",
        "## Minimum Acceptable Evidence",
        "- All 4 planned conditions must execute with parseable metrics.",
        "## Minimum Experiment Plan",
        "- Four planned conditions from the declared grid.",
        "## Allowed Budgeted Passes",
        "- Repeat runs for the baseline and strongest condition when runtime allows."
      ].join("\n")
    );

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                accuracy: 0.95,
                primary_metric: {
                  name: "accuracy",
                  value: 0.95,
                  target: 0.9,
                  met: true
                },
                completed_condition_count: 5,
                condition_summaries: [
                  { condition_marker: "baseline_condition", width: 1, regularization: 0, planned_seed_count: 2, status: "completed" },
                  { condition_marker: "candidate_condition_a", width: 1, regularization: 0.5, planned_seed_count: 2, status: "completed" },
                  { condition_marker: "candidate_condition_b", width: 2, regularization: 0, planned_seed_count: 2, status: "completed" },
                  { condition_marker: "candidate_condition_c", width: 2, regularization: 0.5, planned_seed_count: 2, status: "completed" },
                  { condition_marker: "candidate_condition_d", width: 2, regularization: 1, planned_seed_count: 2, status: "completed" }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner completed with expanded contract",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Planned condition contract expanded");
    expect(result.error).toContain("observed 5 successful condition(s)");
    expect(result.error).toContain("regularization=1 is outside declared values {0,0.5}");
    expect(result.error).toContain("Primary seed contract expanded");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("Planned condition contract expanded");
    expect(verifierReport.summary).toContain("Primary seed contract expanded");
  });

  it("fails verification when a successful command writes top-level failed metrics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-failed-metrics-"));
    process.chdir(root);
    const run = makeRun("run-failed-metrics");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: true,
                candidate_results: [],
                failure: {
                  type: "RuntimeError",
                  message: "No per-candidate execution/evaluation helper was materialized."
                }
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner wrote failed metrics",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment metrics payload reports failed status");
    expect(result.error).toContain("No per-candidate execution/evaluation helper was materialized");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("Experiment metrics payload reports failed status");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
  });

  it("rejects aggregate completion counts when execution rows report evaluation failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-contradictory-row-counts-"));
    process.chdir(root);
    const run = makeRun("run-contradictory-row-counts");
    run.objectiveMetric = "outcome_measure >= 0.01";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                primary_metric_key: "outcome_measure",
                outcome_measure: 0.02,
                completed_run_count: 2,
                required_run_count: 2,
                failed_run_count: 0,
                rows: [
                  {
                    condition_marker: "baseline_condition",
                    seed: 1,
                    status: "evaluation_failed",
                    accuracy: null,
                    error_message: "No execution helper is available"
                  },
                  {
                    condition_marker: "candidate_condition_a",
                    seed: 1,
                    status: "evaluation_failed",
                    accuracy: null,
                    error_message: "No execution helper is available"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner wrote contradictory aggregate metrics",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment row evidence contradicts failed_run_count=0");
    expect(result.error).toContain("Experiment row evidence contradicts completed_run_count=2");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("execution row(s) report failed status");
  });

  it("summarizes completed train-only rows when objective metrics are missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-train-only-metrics-"));
    process.chdir(root);
    const run = makeRun("run-train-only-metrics");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(runDir, { recursive: true });
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                success: true,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 2,
                required_condition_count: 2,
                condition_results: [
                  { condition_marker: "baseline_condition", status: "completed", train_loss: 1.2, wall_time_sec: 3 },
                  {
                    condition_marker: "candidate_condition",
                    status: "unknown",
                    result: { status: "completed", train_loss: 1.1, wall_time_sec: 4 }
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("primary_metric_value=quality_delta:null");
    expect(result.error).toContain("condition_result_statuses=completed:2");
    expect(result.error).toContain("completed_condition_metric_keys=none");
    expect(result.error).toContain("completed_condition_missing_evaluation_metrics=2/2");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { suggested_next_action?: string };
    expect(verifierReport.suggested_next_action).toContain("Repair metrics aggregation");
    expect(verifierReport.suggested_next_action).toContain("condition-level objective");
    expect(verifierReport.suggested_next_action).toContain("model/tokenizer");
  });

  it("rejects a Results V2 artifact that contradicts the required metric direction", async () => {
    const runId = "run-required-metric-direction-mismatch";
    const { result } = await executeMeaningPreservationFixture({
      runId,
      objectiveMetric: "outcome_measure >= 0",
      experimentContract: buildExperimentContractV2Fixture({
        runId,
        metricId: "outcome_measure",
        direction: "higher_better"
      }),
      metrics: {
        status: "completed",
        success: true,
        ...buildExplicitResultsV2Fixture({
          metricId: "outcome_measure",
          direction: "lower_better",
          primaryValue: 0.7
        })
      }
    });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("experiment_contract.results_plan");
    expect(result.error).toContain(
      'results_plan.required_metrics[0] requires direction "higher_better" for metric "outcome_measure"'
    );
  });

  it("projects explicit binary counts into Results V2 observations with count provenance", async () => {
    const rows = [
      ["series-reference", "baseline", 1, "partition-alpha", 5, 10],
      ["series-reference", "baseline", 1, "partition-beta", 4, 10],
      ["series-reference", "baseline", 2, "partition-alpha", 6, 10],
      ["series-reference", "baseline", 2, "partition-beta", 5, 10],
      ["series-primary", "primary", 1, "partition-alpha", 7, 10],
      ["series-primary", "primary", 1, "partition-beta", 6, 10],
      ["series-primary", "primary", 2, "partition-alpha", 8, 10],
      ["series-primary", "primary", 2, "partition-beta", 7, 10]
    ].map(([condition_marker, role, seed, task, correct_count, total_count]) => ({
      condition_marker,
      role,
      seed,
      task,
      status: "completed",
      metric_id: "outcome_rate",
      metric_direction: "higher_better",
      metric_unit: "unitless",
      raw_evidence: {
        task_metrics: {
          [String(task)]: {
            correct_count,
            total_count,
            metric_id: "outcome_rate",
            metric_direction: "higher_better",
            metric_unit: "unitless"
          }
        }
      }
    }));

    const { result, metrics } = await executeMeaningPreservationFixture({
      runId: "run-explicit-binary-count-projection",
      objectiveMetric: "outcome_rate >= 0",
      metrics: {
        status: "completed",
        success: true,
        metric_definitions: [
          { id: "outcome_rate", label: "Outcome rate", direction: "higher_better", unit: "unitless" }
        ],
        raw_condition_results: rows
      }
    });

    expect(result.status, JSON.stringify(result)).toBe("success");
    expect(metrics.outcome_rate).toBeCloseTo(0.7, 6);
    expect(metrics.primary_metric_value).toBeCloseTo(0.7, 6);
    expect(metrics.results_artifact.comparisons).toEqual([]);
    const primaryObservation = metrics.results_artifact.observations.find(
      (item: Record<string, any>) =>
        item.series_id === "series-primary" && item.scope?.aggregation === "pooled_binary_count"
    );
    expect(primaryObservation?.value).toBeCloseTo(0.7, 6);
    expect(metrics.binary_count_evidence).toContainEqual(
      expect.objectContaining({
        observation_id: primaryObservation?.id,
        correct_count: 28,
        total_count: 40,
        seed_count: 2
      })
    );
    expect(metrics.confidence_intervals).toContainEqual(
      expect.objectContaining({ observation_id: primaryObservation?.id, sample_size: 40 })
    );
    expect(metrics.condition_summaries).toBeUndefined();
  });

  it("preserves nested explicit roles and binary counts in Results V2 series", async () => {
    const rows = [
      ["series-reference", "baseline", 1, "partition-alpha", 4, 10],
      ["series-reference", "baseline", 2, "partition-alpha", 6, 10],
      ["series-primary", "primary", 1, "partition-alpha", 7, 10],
      ["series-primary", "primary", 2, "partition-alpha", 9, 10]
    ].map(([condition_marker, role, seed, task, correct_count, total_count]) => ({
      condition_marker,
      task,
      status: "completed",
      raw_evidence: {
        seed,
        raw_evidence: {
          role,
          metric_id: "outcome_rate",
          metric_direction: "higher_better",
          metric_unit: "unitless",
          task_metrics: {
            [String(task)]: {
              correct_count,
              total_count
            }
          }
        }
      }
    }));

    const { result, metrics } = await executeMeaningPreservationFixture({
      runId: "run-nested-explicit-binary-contract",
      objectiveMetric: "outcome_rate >= 0",
      metrics: {
        status: "completed",
        success: true,
        metric_definitions: [
          { id: "outcome_rate", label: "Outcome rate", direction: "higher_better", unit: "unitless" }
        ],
        raw_condition_results: rows
      }
    });

    expect(result.status, JSON.stringify(result, null, 2)).toBe("success");
    expect(metrics.results_artifact.series).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "series-reference", role: "baseline" }),
        expect.objectContaining({ id: "series-primary", role: "primary" })
      ])
    );
    const pooled = metrics.results_artifact.observations.filter(
      (item: Record<string, any>) => item.scope?.aggregation === "pooled_binary_count"
    );
    expect(pooled).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ series_id: "series-reference", value: 0.5 }),
        expect.objectContaining({ series_id: "series-primary", value: 0.8 })
      ])
    );
    expect(metrics.results_artifact.comparisons).toEqual([]);
    expect(metrics.outcome_rate).toBeCloseTo(0.8, 6);
  });

  it.each([
    {
      name: "one row omits its unit",
      secondUnit: undefined,
      expectedDiagnostic: "omitted an explicit metric_id, metric_direction, or metric_unit"
    },
    {
      name: "rows declare conflicting units",
      secondUnit: "percentage_point",
      expectedDiagnostic: "distinct metric contracts"
    }
  ])("rejects binary projection when $name", async ({ secondUnit, expectedDiagnostic }) => {
    const rows = [
      {
        condition_marker: "series-reference",
        role: "baseline",
        status: "completed",
        correct: false,
        metric_id: "outcome_rate",
        metric_direction: "higher_better",
        metric_unit: "unitless"
      },
      {
        condition_marker: "series-primary",
        role: "primary",
        status: "completed",
        correct: true,
        metric_id: "outcome_rate",
        metric_direction: "higher_better",
        ...(secondUnit ? { metric_unit: secondUnit } : {})
      }
    ];
    const { result, metrics } = await executeMeaningPreservationFixture({
      runId: `run-binary-unit-${secondUnit ?? "missing"}`,
      objectiveMetric: "outcome_rate >= 0",
      metrics: {
        status: "completed",
        success: true,
        metric_definitions: [
          { id: "outcome_rate", label: "Outcome rate", direction: "higher_better", unit: "unitless" }
        ],
        condition_results: rows
      }
    });

    expect(result.status).toBe("failure");
    expect(metrics.results_artifact).toBeUndefined();
    expect(metrics.run_experiments_diagnostics).toContainEqual(
      expect.objectContaining({
        code: "binary_projection_skipped_missing_metric_contract",
        message: expect.stringContaining(expectedDiagnostic)
      })
    );
  });

  it("uses failed metrics payload as feedback when the command exits unsuccessfully", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-failed-command-metrics-"));
    process.chdir(root);
    const run = makeRun("run-failed-command-metrics");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(root, "study_failure.json"),
            JSON.stringify(
              {
                error: "TypeError: _build_model_load_kwargs() missing 1 required positional argument: 'local_files_only'",
                traceback: [
                  "Traceback (most recent call last):",
                  "  File \"experiment.py\", line 1, in <module>",
                  "TypeError: _build_model_load_kwargs() missing 1 required positional argument: 'local_files_only'"
                ].join("\n")
              },
              null,
              2
            ),
            "utf8"
          );
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 8,
                observed_condition_count: 31,
                missing_required_condition_markers: ["baseline_condition", "candidate_condition_a"],
                condition_results_path: path.join(root, "condition_results.json"),
                condition_results: [
                  { condition_id: "baseline_condition", status: "missing", reason: "ok_without_condition_records" },
                  { condition_id: "candidate_condition_a", status: "missing", reason: "ok_without_condition_records" }
                ],
                evidence: [
                  {
                    kind: "orchestration_exception",
                    message: "Could not resolve run-plan construction helper from the current module state.",
                    traceback: "RuntimeError: Could not resolve run-plan construction helper from the current module state."
                  }
                ],
                error: {
                  type: "AttributeError",
                  message: "dict object has no attribute baseline_run"
                },
                error_messages: [
                  "TypeError: SyntheticRunSpec.__init__() missing required argument output_dir"
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "error" as const,
            stdout: "verbose model loading log",
            stderr: "status=failed | completed_conditions=0",
            exit_code: 1,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment metrics payload reports failed status");
    expect(result.error).toContain("completed_condition_count=0/8");
    expect(result.error).toContain("primary_metric_value=quality_delta:null");
    expect(result.error).toContain("condition_result_statuses=missing:2");
    expect(result.error).toContain("condition_result_reasons=ok_without_condition_records:2");
    expect(result.error).toContain("missing_required_condition_markers=baseline_condition,candidate_condition_a");
    expect(result.error).toContain("_build_model_load_kwargs()");
    expect(result.error).toContain("local_files_only");
    expect(result.error).toContain("metrics_evidence=orchestration_exception");
    expect(result.error).toContain("run-plan construction helper");
    expect(result.error).toContain("baseline_run");
    expect(result.error).toContain("metrics_error_messages=TypeError: SyntheticRunSpec.__init__()");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; stderr_excerpt?: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("completed_condition_count=0/8");
    expect(verifierReport.summary).toContain("primary_metric_value=quality_delta:null");
    expect(verifierReport.summary).toContain("condition_result_statuses=missing:2");
    expect(verifierReport.summary).toContain("metrics_error=AttributeError");
    expect(verifierReport.summary).toContain("metrics_error_messages=TypeError: SyntheticRunSpec.__init__()");
    expect(verifierReport.summary).toContain("metrics_evidence=orchestration_exception");
    expect(verifierReport.summary).toContain("run-plan construction helper");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(feedback?.summary).toContain("condition_result_reasons=ok_without_condition_records:2");
    expect(feedback?.summary).toContain("observed_condition_count=31");
    expect(feedback?.summary).toContain("_build_model_load_kwargs()");
    expect(feedback?.summary).toContain("baseline_run");
    expect(feedback?.summary).toContain("SyntheticRunSpec.__init__()");
    expect(feedback?.summary).toContain("run-plan construction helper");
  });

  it("suggests repairing evaluation normalization when no objective metric is produced", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-no-objective-metric-"));
    process.chdir(root);
    const run = makeRun("run-no-objective-metric");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "evaluation produced no objective metric",
                    raw_evidence: {
                      task_metrics: { task_a: { accuracy: null, evaluated: 0, requested: 12 } }
                    }
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "evaluation produced no objective metric",
                    raw_evidence: {
                      task_metrics: { task_a: { accuracy: null, evaluated: 0, requested: 12 } }
                    }
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("evaluation produced no objective metric:2");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair evaluation data normalization");
    expect(verifierReport.suggested_next_action).toContain("answer_index");
    expect(verifierReport.suggested_next_action).toContain("correct_index");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("evaluated counts nonzero");
  });

  it("suggests repairing evaluation handoff when train-complete conditions are skipped before scoring", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-eval-handoff-skip-"));
    process.chdir(root);
    const run = makeRun("run-eval-handoff-skip");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "evaluation produced no objective metric",
                    raw_evidence: {
                      status: "completed_training",
                      evaluation_status: "skipped_not_completed",
                      task_metrics: {}
                    }
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "evaluation produced no objective metric",
                    raw_evidence: {
                      status: "completed_training",
                      evaluation_status: "skipped_not_completed",
                      task_metrics: {}
                    }
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("condition_evaluation_statuses=skipped_not_completed:2");
    expect(result.error).toContain("condition_training_statuses=completed_training:2");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair condition evaluation handoff");
    expect(verifierReport.suggested_next_action).toContain("completed_training");
    expect(verifierReport.suggested_next_action).toContain("skipped_not_completed");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("evaluators must run after training");
  });

  it("suggests repairing evaluation handoff when train-complete rows are final evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-train-only-final-"));
    process.chdir(root);
    const run = makeRun("run-train-only-final");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "completed_training",
                    task_metrics: {}
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "completed_training",
                    task_metrics: {}
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("condition_result_statuses=completed_training:2");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair condition evaluation handoff");
    expect(verifierReport.suggested_next_action).toContain("train-only completion");
    expect(verifierReport.suggested_next_action).toContain("model/tokenizer");
    expect(verifierReport.suggested_next_action).not.toContain("Repair evaluation data normalization");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("task_metrics must be populated");
  });

  it("suggests repairing artifact reload when evaluation loads from the process cwd", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-artifact-reload-"));
    process.chdir(root);
    const run = makeRun("run-artifact-reload");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "evaluation produced no objective metric",
                    raw_evidence: {
                      status: "evaluation_failed_runtime_load",
                      diagnostics: { error: "ValueError(\"Can't find 'runtime_artifact.json' at '.'\")" },
                      task_metrics: {}
                    }
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "evaluation produced no objective metric",
                    raw_evidence: {
                      status: "evaluation_failed_runtime_load",
                      diagnostics: { error: "ValueError(\"Can't find 'runtime_artifact.json' at '.'\")" },
                      task_metrics: {}
                    }
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("condition_training_statuses=evaluation_failed_runtime_load:2");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair evaluation artifact reload");
    expect(verifierReport.suggested_next_action).toContain("process cwd");
    expect(verifierReport.suggested_next_action).toContain("explicit path");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("artifact-path diagnostics");
  });

  it("suggests repairing evaluation invocation bridge when evaluator state is omitted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-eval-invocation-"));
    process.chdir(root);
    const run = makeRun("run-eval-invocation");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "evaluation call failed: TypeError(\"Cannot call evaluate_condition without required argument 'state'\")",
                    raw_evidence: {
                      error: "TypeError(\"Cannot call evaluate_condition without required argument 'state'\")"
                    }
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "evaluation call failed: TypeError(\"Cannot call evaluate_condition without required argument 'state'\")",
                    raw_evidence: {
                      error: "TypeError(\"Cannot call evaluate_condition without required argument 'state'\")"
                    }
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("evaluation call failed");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair the evaluation invocation bridge");
    expect(verifierReport.suggested_next_action).toContain("state");
    expect(verifierReport.suggested_next_action).toContain("condition_result");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("signature diagnostics");
  });

  it("suggests repairing invocation bridge when loaders or condition runners miss required bundles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-missing-task-bundle-"));
    process.chdir(root);
    const run = makeRun("run-missing-task-bundle");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 3,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "TypeError(\"Cannot call run_single_condition without required argument 'task_bundle'\")"
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "TypeError(\"Cannot call execute_condition without required argument 'task_data'\")"
                  },
                  {
                    condition_marker: "candidate_condition_b",
                    status: "failed",
                    reason: "RuntimeError('Experiment data bundle could not be materialized: load_training_examples: TypeError(\"Cannot call load_training_examples without required argument \'runtime\'\")')"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("required argument 'task_bundle'");
    expect(result.error).toContain("required argument 'task_data'");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair the experiment invocation bridge");
    expect(verifierReport.suggested_next_action).toContain("task_bundle");
    expect(verifierReport.suggested_next_action).toContain("task_data");
    expect(verifierReport.suggested_next_action).toContain("dataset_bundle");
    expect(verifierReport.suggested_next_action).toContain("runtime");
    expect(verifierReport.suggested_next_action).toContain("run_context");
    expect(verifierReport.suggested_next_action).toContain("data loader");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("eval_examples_by_task");
    expect(feedback?.suggested_next_action).toContain("runtime_context");
  });

  it("suggests repairing invocation bridge when evaluators miss eval sets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-missing-eval-sets-"));
    process.chdir(root);
    const run = makeRun("run-missing-eval-sets");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "evaluation call failed: TypeError(\"Cannot call evaluate_condition_outputs without required argument 'eval_sets'\")"
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "evaluation call failed: TypeError(\"Cannot call evaluate_condition_outputs without required argument 'eval_sets'\")"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("required argument 'eval_sets'");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair the experiment invocation bridge");
    expect(verifierReport.suggested_next_action).toContain("eval_sets");
    expect(verifierReport.suggested_next_action).toContain("eval_examples_by_task");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("benchmark_examples");
  });

  it("suggests repairing invocation bridge when evaluators miss runtime context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-missing-runtime-context-"));
    process.chdir(root);
    const run = makeRun("run-missing-runtime-context");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "evaluation call failed: TypeError(\"Cannot call evaluate_condition without required argument 'run'\")"
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "evaluation call failed: TypeError(\"Cannot call evaluate_condition without required argument 'run'\")"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("required argument 'run'");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair the experiment invocation bridge");
    expect(verifierReport.suggested_next_action).toContain("run");
    expect(verifierReport.suggested_next_action).toContain("runtime_context");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("condition_result");
  });

  it("suggests repairing invocation bridge when evaluators miss artifact paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-missing-eval-paths-"));
    process.chdir(root);
    const run = makeRun("run-missing-eval-paths");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "evaluation call failed: TypeError(\"Cannot call evaluate_completed_condition without required argument 'paths'\")"
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "evaluation call failed: TypeError(\"Cannot call evaluate_completed_condition without required argument 'paths'\")"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("required argument 'paths'");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair the experiment invocation bridge");
    expect(verifierReport.suggested_next_action).toContain("paths");
    expect(verifierReport.suggested_next_action).toContain("artifact_paths");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("output_paths");
  });

  it("suggests repairing runtime config defaults when Namespace attributes are missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-missing-runtime-default-"));
    process.chdir(root);
    const run = makeRun("run-missing-runtime-default");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "{'stage': 'condition_model_execution', 'error_type': 'AttributeError', 'message': \"'Namespace' object has no attribute 'allow_model_download'\"}"
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "{'stage': 'condition_model_execution', 'error_type': 'AttributeError', 'message': \"'Namespace' object has no attribute 'allow_model_download'\"}"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Namespace");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair runtime config defaults");
    expect(verifierReport.suggested_next_action).toContain("allow_model_download");
    expect(verifierReport.suggested_next_action).toContain("local_files_only");
    expect(verifierReport.suggested_next_action).toContain("artifact_dir");
    expect(verifierReport.suggested_next_action).toContain("condition_output_dir");
    expect(verifierReport.suggested_next_action).toContain("paths");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("cache_dir");
    expect(feedback?.suggested_next_action).toContain("run_artifact_dir");
    expect(feedback?.suggested_next_action).toContain("runtime_paths");
  });

  it("suggests repairing runtime path aliases when Namespace artifact directories are missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-missing-runtime-path-alias-"));
    process.chdir(root);
    const run = makeRun("run-missing-runtime-path-alias");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "AttributeError(\"'Namespace' object has no attribute 'artifact_dir'\")"
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "AttributeError(\"'Namespace' object has no attribute 'condition_output_dir'\")"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("artifact_dir");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair runtime config defaults");
    expect(verifierReport.suggested_next_action).toContain("artifact_dir");
    expect(verifierReport.suggested_next_action).toContain("condition_output_dir");
    expect(verifierReport.suggested_next_action).toContain("run_artifact_dir");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("path aliases");
  });

  it("suggests repairing runtime config helper capabilities when config methods are missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-missing-runtime-helper-"));
    process.chdir(root);
    const run = makeRun("run-missing-runtime-helper");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "'RunnerConfig' object has no attribute 'ensure_dirs'"
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "'RunnerConfig' object has no attribute 'ensure_dirs'"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("RunnerConfig");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair runtime config defaults");
    expect(verifierReport.suggested_next_action).toContain("helper capabilities");
    expect(verifierReport.suggested_next_action).toContain("ensure_dirs");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("ensure_dirs");
  });

  it("suggests repairing runtime budget defaults when budget attributes are missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-missing-budget-default-"));
    process.chdir(root);
    const run = makeRun("run-missing-budget-default");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "AttributeError(\"'_AutoLabOSEntrypointBudget' object has no attribute 'seed'\")"
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "AttributeError(\"'_AutoLabOSEntrypointBudget' object has no attribute 'seed'\")"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("_AutoLabOSEntrypointBudget");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair runtime config defaults");
    expect(verifierReport.suggested_next_action).toContain("seed");
    expect(verifierReport.suggested_next_action).toContain("max_train_examples");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("max_eval_examples_per_task");
  });

  it("suggests repairing data materialization when training examples are unavailable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-missing-train-examples-"));
    process.chdir(root);
    const run = makeRun("run-missing-train-examples");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "no training examples were provided for real condition execution"
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "no training examples were provided for real condition execution"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("no training examples were provided");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair data materialization");
    expect(verifierReport.suggested_next_action).toContain("train_records");
    expect(verifierReport.suggested_next_action).toContain("data_access");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("evaluation examples");
  });

  it("suggests repairing training text normalization when loaded records normalize to zero usable texts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-zero-usable-train-texts-"));
    process.chdir(root);
    const run = makeRun("run-zero-usable-train-texts");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "data_access produced zero usable instruction/training texts",
                    raw_evidence: {
                      status: "failed",
                      training_status: "failed",
                      evaluation_status: "skipped_not_completed"
                    }
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "data_access_failure: zero usable training texts after normalization",
                    raw_evidence: {
                      status: "failed",
                      training_status: "failed",
                      evaluation_status: "skipped_not_completed"
                    }
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("zero usable instruction/training texts");
    expect(result.error).toContain("zero usable training texts after normalization");
    expect(result.error).toContain("condition_evaluation_statuses=skipped_not_completed:2");
    expect(result.error).toContain("condition_training_statuses=failed:2");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair data materialization");
    expect(verifierReport.suggested_next_action).toContain("train_records");
    expect(verifierReport.suggested_next_action).toContain("messages");
    expect(verifierReport.suggested_next_action).not.toContain("Repair condition evaluation handoff");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("empty train set");
  });

  it("suggests repairing condition normalization when tuple condition records reach execution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-condition-normalization-"));
    process.chdir(root);
    const run = makeRun("run-condition-normalization");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  { condition_marker: "condition", status: "failed", reason: "AttributeError(\"'tuple' object has no attribute 'condition_parameter_x'\")" },
                  { condition_marker: "condition", status: "failed", reason: "AttributeError(\"'tuple' object has no attribute 'condition_parameter_x'\")" }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("tuple");
    expect(result.error).toContain("condition_parameter_x");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair condition normalization");
    expect(verifierReport.suggested_next_action).toContain("tuple");
    expect(verifierReport.suggested_next_action).toContain("stable condition identifiers");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("mapping");
  });

  it("suggests repairing record shape normalization when mapping records are numerically indexed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-record-shape-indexing-"));
    process.chdir(root);
    const run = makeRun("run-record-shape-indexing");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  { condition_marker: "baseline_condition", status: "failed", failure_reason: "KeyError(0)" },
                  { condition_marker: "candidate_condition", status: "failed", failure_reason: "KeyError(0)" }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("KeyError(0)");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair record shape normalization");
    expect(verifierReport.suggested_next_action).toContain("mapping");
    expect(verifierReport.suggested_next_action).toContain("[0]");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("schema diagnostics");
  });

  it("suggests repairing evaluation record normalization when scalar records break label access", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-eval-scalar-record-normalization-"));
    process.chdir(root);
    const run = makeRun("run-eval-scalar-record-normalization");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                error:
                  "RuntimeError('Experiment data bundle could not be materialized: load_task_bundle: DataAccessError({\"message\":\"real dataset access/normalization failed\",\"missing_eval_tasks\":[\"task_alpha\"],\"diagnostics\":{\"tasks\":{\"task_alpha\":{\"error\":\"argument of type \\'int\\' is not iterable\"},\"task_beta\":{\"train_usable\":96,\"eval_usable\":64}},\"schema_failures\":[\"argument of type \\'int\\' is not iterable\"]}})')"
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("argument of type \\'int\\' is not iterable");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("Repair evaluation record normalization");
    expect(verifierReport.suggested_next_action).toContain("field in record");
    expect(verifierReport.suggested_next_action).not.toContain("Repair data materialization");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback?.suggested_next_action).toContain("scalar evaluation records");
  });

  it("suggests preserving evaluator runtime handles when completed conditions cannot be scored", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-missing-eval-handles-"));
    process.chdir(root);
    const run = makeRun("run-missing-eval-handles");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    reason: "completed condition did not expose model/tokenizer for real evaluation"
                  },
                  {
                    condition_marker: "candidate_condition",
                    status: "failed",
                    reason: "completed condition did not expose model/tokenizer for real evaluation"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "status=failed", exit_code: 1, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("completed_condition_count=0/2");
    expect(result.error).toContain("completed condition did not expose model/tokenizer for real evaluation:2");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "metrics" });
    expect(verifierReport.suggested_next_action).toContain("preserve evaluator-required runtime handles");
    expect(verifierReport.suggested_next_action).toContain("reload the saved condition artifact");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback).toMatchObject({ status: "fail", stage: "metrics" });
    expect(feedback?.suggested_next_action).toContain("preserve evaluator-required runtime handles");
  });

  it("surfaces model download cache dependency failures when no metrics are written", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-command-dependency-failure-"));
    process.chdir(root);
    const run = makeRun("run-command-dependency-failure");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const runCommand = vi.fn(async () => ({
      status: "error" as const,
      stdout: "Generating benchmark_task_a split...",
      stderr: [
        "Loading tokenizer with from_pretrained",
        "xet retry failed: failed to lookup address information: Temporary failure in name resolution",
        "artifact model cache contains an incomplete blob"
      ].join("\n"),
      exit_code: 1,
      duration_ms: 10
    }));

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand,
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(result.error).toContain("exit_code=1");
    expect(result.error).toContain("metrics_written=false");
    expect(result.error).toContain("model_download_or_cache_failure=true");
    expect(result.error).toContain("Temporary failure in name resolution");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as {
      status: string;
      stage: string;
      summary: string;
      suggested_next_action?: string;
      metrics_path?: string;
      exit_code?: number;
    };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "command",
      exit_code: 1
    });
    expect(verifierReport.summary).toContain("metrics_written=false");
    expect(verifierReport.summary).toContain("model_download_or_cache_failure=true");
    expect(verifierReport.metrics_path).toContain("metrics.json");
    expect(verifierReport.suggested_next_action).toContain("standard Hugging Face cache");
    expect(verifierReport.suggested_next_action).toContain("avoid artifact-local model cache redownloads");

    const feedback = await runContext.get<{ status: string; stage: string; summary: string; suggested_next_action?: string }>(
      "implement_experiments.runner_feedback"
    );
    expect(feedback).toMatchObject({
      status: "fail",
      stage: "command"
    });
    expect(feedback?.summary).toContain("metrics_written=false");
    expect(feedback?.summary).toContain("model_download_or_cache_failure=true");
  });
  it("prioritizes entrypoint failed metrics over warning-only stderr on command failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-entrypoint-failed-metrics-"));
    process.chdir(root);
    const run = makeRun("run-entrypoint-failed-metrics");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "entrypoint_failed",
                success: false,
                completed_condition_count: 0,
                required_condition_count: 12,
                completed_run_count: 0,
                required_run_count: 36,
                error_type: "RuntimeError",
                error_message: "Missing run-plan execution helper in experiment scaffold.",
                traceback: "RuntimeError: Missing run-plan execution helper in experiment scaffold.",
                condition_results: [
                  {
                    completed: false,
                    condition: { marker: "baseline_condition" },
                    train_result: { status: "failed", failure_reason: "No training examples were provided" }
                  },
                  {
                    completed: false,
                    status: "failed",
                    condition: { marker: "candidate_condition" },
                    failure: { message: "No training examples were provided" }
                  }
                ],
                raw_condition_results: [
                  {
                    status: "failed",
                    condition_marker: "candidate_condition_b",
                    failure_stage: "evaluation",
                    failure_reason: "no objective evaluation callable was available"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "error" as const,
            stdout: "",
            stderr: "`torch_dtype` is deprecated! Use `dtype` instead!\nLoading weights: 100%|done|",
            exit_code: 1,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment metrics payload reports failed status");
    expect(result.error).toContain("Missing run-plan execution helper");
    expect(result.error).toContain("completed_condition_count=0/12");
    expect(result.error).toContain("condition_result_statuses=failed:3");
    expect(result.error).toContain("condition_result_reasons=No training examples were provided:2");
    expect(result.error).toContain("no objective evaluation callable was available:1");
    expect(result.error).toContain("condition_result_samples=baseline_condition,status=failed,reason=No training examples were provided");
    expect(result.error).not.toContain("unlabeled_condition,status=failed");
    expect(result.error).not.toContain("torch_dtype");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("Missing run-plan execution helper");
    expect(verifierReport.summary).toContain("no objective evaluation callable was available:1");
    expect(verifierReport.summary).toContain("condition_result_samples=baseline_condition,status=failed,reason=No training examples were provided");
    expect(verifierReport.summary).not.toContain("unlabeled_condition,status=failed");
    expect(verifierReport.summary).not.toContain("torch_dtype");
  });

  it("includes data access preview diagnostics when failed metrics hide empty training data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-data-access-preview-"));
    process.chdir(root);
    const run = makeRun("run-data-access-preview");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    const publicDir = path.join(root, "public_experiment");
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(publicDir, { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.public_dir", publicDir);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(publicDir, "data_access_preview.json"),
            JSON.stringify(
              {
                train_count: 0,
                eval_counts: { benchmark_task_a: 2 },
                diagnostics: {
                  schema_errors: ["No usable instruction/training texts normalized from loaded records."],
                  tasks: {
                    benchmark_task_a: {
                      normalized_train_count: 0,
                      normalized_eval_count: 2
                    }
                  }
                },
                sample_train: null
              },
              null,
              2
            ),
            "utf8"
          );
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                success: false,
                primary_metric_key: "quality_delta",
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                raw_condition_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    error_type: "IndexError",
                    failure_reason: "list index out of range"
                  },
                  {
                    condition_marker: "candidate_condition_a",
                    status: "failed",
                    error_type: "IndexError",
                    failure_reason: "list index out of range"
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "Loading weights: 100%|done|",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment metrics payload reports failed status");
    expect(result.error).toContain("completed_condition_count=0/2");
    expect(result.error).toContain("condition_result_reasons=list index out of range:2");
    expect(result.error).toContain("data_access_preview.json");
    expect(result.error).toContain("train_count=0");
    expect(result.error).toContain("zero usable instruction/training texts");
    expect(result.error).toContain("schema_errors=No usable instruction/training texts normalized from loaded records.");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("data_access_preview.json");
    expect(verifierReport.suggested_next_action).toContain("Repair data materialization before retrying");
  });

  it('promotes raw evidence path model-load failures into dependency blocker feedback', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'autolabos-run-raw-model-load-evidence-'));
    process.chdir(root);
    const run = makeRun('run-raw-model-load-evidence');
    run.objectiveMetric = 'quality_delta >= 0.1';
    const runDir = path.join(root, '.autolabos', 'runs', run.id);
    await mkdir(path.join(runDir, 'memory'), { recursive: true });

    const rawEvidencePath = path.join(root, 'raw_condition_seed_records.jsonl');
    const rawRows = [
      { condition: 'baseline_condition', seed: 1, stage: 'model_load', status: 'failed' },
      { condition: 'baseline_condition', seed: 2, stage: 'model_load', status: 'failed' },
      { condition: 'candidate_condition_a', seed: 1, stage: 'model_load', status: 'failed' },
      { condition: 'candidate_condition_a', seed: 2, stage: 'model_load', status: 'failed' }
    ].map((row) => ({
      ...row,
      model_load_errors: {
        'neutral-model/local-base': 'ModuleNotFoundError: Could not import module ExampleTokenizerDependency. Are this objects requirements defined correctly?'
      }
    }));

    const runContext = new RunContextMemory(path.join(runDir, 'memory', 'run_context.json'));
    await runContext.put('implement_experiments.run_command', 'python3 experiment.py');
    await runContext.put('implement_experiments.cwd', root);
    await runContext.put('implement_experiments.metrics_path', '.autolabos/runs/' + run.id + '/metrics.json');

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: 'local',
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            rawEvidencePath,
            rawRows.map((row) => JSON.stringify({ record: row, time: 1 })).join('\n') + '\n',
            'utf8'
          );
          await writeFile(
            path.join(runDir, 'metrics.json'),
            JSON.stringify(
              {
                status: 'completed',
                success: true,
                primary_metric_key: 'quality_delta',
                quality_delta: null,
                completed_condition_count: 0,
                required_condition_count: 2,
                completed_run_count: 0,
                required_run_count: 4,
                raw_evidence_path: rawEvidencePath,
                condition_results: [
                  { condition_marker: 'baseline_condition', status: 'failed' },
                  { condition_marker: 'candidate_condition_a', status: 'failed' }
                ]
              },
              null,
              2
            ),
            'utf8'
          );
          return {
            status: 'ok' as const,
            stdout: 'experiment command completed',
            stderr: '',
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: 'ok' as const,
          stdout: '',
          stderr: '',
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe('failure');
    expect(result.error).toContain('Experiment dependency blocker');
    expect(result.error).toContain('model asset required model/tokenizer asset could not be loaded');
    expect(result.error).toContain('No condition metrics were accepted as evidence');

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, 'run_experiments_verify_report.json'), 'utf8')
    ) as {
      status: string;
      stage: string;
      summary: string;
      suggested_next_action?: string;
      failure_code?: string;
      repair_target?: string;
      recommended_backtrack_node?: string;
      upstream_repair_hint?: string;
      operator_action_required?: boolean;
    };
    expect(verifierReport).toMatchObject({
      status: 'fail',
      stage: 'metrics',
      failure_code: 'model_dependency_unavailable',
      repair_target: 'environment_dependency',
      recommended_backtrack_node: 'design_experiments',
      operator_action_required: true
    });
    expect(verifierReport.summary).toContain('Experiment dependency blocker');
    expect(verifierReport.suggested_next_action).toContain('Prewarm or make the required experiment dependency available');
    expect(verifierReport.upstream_repair_hint).toContain('select an available local model');

    const triage = JSON.parse(
      await readFile(path.join(runDir, 'run_experiments_panel', 'triage.json'), 'utf8')
    ) as { final_category?: string };
    expect(triage.final_category).toBe('dependency_blocker');

    const feedback = await runContext.get<{
      status: string;
      stage: string;
      summary: string;
      failure_code?: string;
      repair_target?: string;
      recommended_backtrack_node?: string;
    }>('implement_experiments.runner_feedback');
    expect(feedback?.summary).toContain('Experiment dependency blocker');
    expect(feedback?.failure_code).toBe('model_dependency_unavailable');
    expect(feedback?.repair_target).toBe('environment_dependency');
    expect(feedback?.recommended_backtrack_node).toBe('design_experiments');
  });

  it("blocks canonical skeleton-only Python runners before executing stale metrics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-skeleton-preflight-"));
    process.chdir(root);
    const run = makeRun("run-skeleton-preflight");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    const scriptPath = path.join(root, "generated_runner.py");
    await writeFile(
      scriptPath,
      [
        "# AUTOLABOS CANONICAL SKELETON",
        "# BEGIN AUTOLABOS SECTION runner_contract :: Runner imports and execution contract",
        "import argparse",
        "from dataclasses import dataclass",
        "",
        "@dataclass",
        "class RuntimeConfig:",
        "    output_dir: str",
        "",
        "def parse_args(argv=None):",
        "    return argparse.Namespace(output_dir='outputs')",
        "# END AUTOLABOS SECTION runner_contract",
        "",
        "# BEGIN AUTOLABOS SECTION runner_entrypoint :: CLI entrypoint and final handoff",
        "# END AUTOLABOS SECTION runner_entrypoint",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "metrics.json"),
      JSON.stringify(
        {
          status: "completed",
          completed_condition_count: 2,
          required_condition_count: 2,
          quality_delta: 0.2
        },
        null,
        2
      ),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 " + JSON.stringify(scriptPath));
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.script", scriptPath);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      aci: {
        runCommand: async () => {
          throw new Error("skeleton preflight should block before command execution");
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("canonical skeleton");
    expect(result.error).toContain("stale metrics");
    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({ status: "fail", stage: "preflight_test" });
    expect(verifierReport.summary).toContain("canonical skeleton");
    expect(verifierReport.suggested_next_action).toContain("runnable implementation");
  });

  it("blocks partial canonical skeleton runners with empty evaluation metrics or entrypoint sections", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-partial-skeleton-preflight-"));
    process.chdir(root);
    const run = makeRun("run-partial-skeleton-preflight");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    const scriptPath = path.join(root, "generated_runner.py");
    await writeFile(
      scriptPath,
      [
        "# AUTOLABOS CANONICAL SKELETON",
        "import sys",
        "# BEGIN AUTOLABOS SECTION runner_contract :: Runner imports and execution contract",
        "def build_plan():",
        "    return ['baseline_condition', 'candidate_condition_a']",
        "# END AUTOLABOS SECTION runner_contract",
        "",
        "# BEGIN AUTOLABOS SECTION runner_evaluation :: Task evaluation and raw evidence capture",
        "# END AUTOLABOS SECTION runner_evaluation",
        "",
        "# BEGIN AUTOLABOS SECTION runner_metrics :: Metric aggregation and failure-safe payload",
        "# END AUTOLABOS SECTION runner_metrics",
        "",
        "# BEGIN AUTOLABOS SECTION runner_entrypoint :: CLI entrypoint and final handoff",
        "def main():",
        "    return 0",
        "if __name__ == '__main__':",
        "    raise SystemExit(main())",
        "# END AUTOLABOS SECTION runner_entrypoint",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "metrics.json"),
      JSON.stringify(
        {
          status: "completed",
          completed_condition_count: 2,
          required_condition_count: 2,
          quality_delta: 0.2
        },
        null,
        2
      ),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 " + JSON.stringify(scriptPath));
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.script", scriptPath);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      aci: {
        runCommand: async () => {
          throw new Error("partial skeleton preflight should block before command execution");
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("canonical skeleton");
    expect(result.error).toContain("stale metrics");
  });

  it("preserves rejected metrics when a rejected rerun writes failed metrics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-restore-rejected-metrics-"));
    process.chdir(root);
    const run = makeRun("run-restore-rejected-metrics");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const previousMetrics = {
      status: "completed",
      success: true,
      ...buildExplicitResultsV2Fixture({
        metricId: "outcome_measure",
        primaryValue: 0.54,
        referenceValue: 0.5,
        comparisonDelta: 0.04
      }),
      completed_condition_count: 2,
      required_condition_count: 2
    };
    await writeFile(path.join(runDir, "metrics.json"), JSON.stringify(previousMetrics, null, 2), "utf8");

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "node generated_runner.js");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                completed_condition_count: 0,
                required_condition_count: 2,
                error: "No locked conditions are available to select from."
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 5 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("No locked conditions are available");
    const rejectedMetrics = JSON.parse(await readFile(path.join(runDir, "metrics.json"), "utf8"));
    expect(rejectedMetrics).toMatchObject({
      status: "failed",
      completed_condition_count: 0,
      required_condition_count: 2,
      error: "No locked conditions are available to select from."
    });
    await expect(runContext.get("run_experiments.restored_previous_metrics_after_failure")).resolves.toBeUndefined();
  });

  it("rejects zero-exit runtime tracebacks instead of recovering stale public metrics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-zero-exit-stale-public-metrics-"));
    process.chdir(root);
    const run = makeRun("run-zero-exit-stale-public-metrics");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    const publicDir = path.join(root, "outputs", "neutral-study", "experiment");
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(publicDir, { recursive: true });

    const previousMetrics = {
      status: "completed",
      success: true,
      ...buildExplicitResultsV2Fixture({
        metricId: "outcome_measure",
        primaryValue: 0.54,
        referenceValue: 0.5,
        comparisonDelta: 0.04
      }),
      completed_condition_count: 2,
      required_condition_count: 2
    };
    await writeFile(path.join(runDir, "metrics.json"), JSON.stringify(previousMetrics, null, 2), "utf8");
    await writeFile(
      path.join(publicDir, "metrics.json"),
      JSON.stringify(
        {
          status: "completed",
          success: true,
          ...buildExplicitResultsV2Fixture({
            metricId: "outcome_measure",
            primaryValue: 0.5,
            referenceValue: 0.5,
            comparisonDelta: 0
          }),
          completed_condition_count: 2,
          required_condition_count: 2
        },
        null,
        2
      ),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 generated_runner.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.public_dir", publicDir);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: [
            "Experiment execution failed before normal finalization.",
            "Traceback (most recent call last):",
            "TypeError: _as_path() missing 1 required positional argument: fallback"
          ].join("\n"),
          exit_code: 0,
          duration_ms: 5
        }),
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("fatal stderr despite zero exit status");
    expect(result.error).toContain("_as_path()");
    const restoredMetrics = JSON.parse(await readFile(path.join(runDir, "metrics.json"), "utf8"));
    expect(restoredMetrics).toMatchObject(previousMetrics);
    await expect(runContext.get("run_experiments.recovered_public_metrics_path")).resolves.toBeUndefined();
  });

  it("surfaces string metrics error before stale failure artifact evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-string-metrics-error-"));
    process.chdir(root);
    const run = makeRun("run-string-metrics-error");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(root, "study_failure.json"),
            JSON.stringify({ error: "old stale failure" }, null, 2),
            "utf8"
          );
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                error: "write_experiment_artifacts() missing 4 required positional arguments"
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "", exit_code: 1, duration_ms: 5 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("write_experiment_artifacts()");
    expect(result.error).toContain("metrics_error=write_experiment_artifacts()");
    expect(result.error).toContain("old stale failure");
  });

  it("archives preexisting failure artifacts before running a fresh experiment command", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-clear-stale-failure-artifact-"));
    process.chdir(root);
    const run = makeRun("run-clear-stale-failure-artifact");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    const publicDir = path.join(root, "public");
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await writeFile(path.join(root, "study_failure.json"), JSON.stringify({ error: "old stale failure" }), "utf8");
    const nestedFailurePath = path.join(root, "condition_artifacts", "condition_a", "seed_1", "failure.json");
    await mkdir(path.dirname(nestedFailurePath), { recursive: true });
    await writeFile(nestedFailurePath, JSON.stringify({ error: "old nested stale failure" }), "utf8");
    const rawEvidencePath = path.join(root, "artifacts", "raw_evaluation_evidence.jsonl");
    await mkdir(path.dirname(rawEvidencePath), { recursive: true });
    await writeFile(rawEvidencePath, JSON.stringify({ status: "condition_evaluation_summary", schema_diagnostics: ["old stale diagnostic"] }) + "\n", "utf8");
    const publicRawEvidencePath = path.join(publicDir, "artifacts", "raw_evaluation_evidence.jsonl");
    await mkdir(path.dirname(publicRawEvidencePath), { recursive: true });
    await writeFile(publicRawEvidencePath, JSON.stringify({ status: "condition_evaluation_summary", schema_diagnostics: ["old public stale diagnostic"] }) + "\n", "utf8");

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.public_dir", publicDir);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                completed_run_count: 0,
                completed_condition_count: 0,
                selected_model: null,
                per_seed_rows: [
                  {
                    condition_marker: "baseline_condition",
                    seed: 42,
                    status: "failed",
                    failure_reason: "missing_row_for_required_condition_seed"
                  }
                ],
                error: "fresh run produced no executable rows"
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "error" as const, stdout: "", stderr: "", exit_code: 1, duration_ms: 5 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("fresh run produced no executable rows");
    expect(result.error).toContain("selected_model=null");
    expect(result.error).toContain("missing_row_for_required_condition_seed");
    expect(result.error).not.toContain("old stale failure");
    expect(result.error).not.toContain("old nested stale failure");
    await expect(readFile(nestedFailurePath, "utf8")).rejects.toThrow();
    const backups = await runContext.get<string[]>("run_experiments.previous_failure_artifact_backups");
    expect(backups).toHaveLength(2);
    expect(backups?.some((backup) => backup.includes("preexisting_study_failure"))).toBe(true);
    expect(backups?.some((backup) => backup.includes("preexisting_nested_failure"))).toBe(true);
    await expect(readFile(rawEvidencePath, "utf8")).rejects.toThrow();
    await expect(readFile(publicRawEvidencePath, "utf8")).rejects.toThrow();
    const evidenceBackups = await runContext.get<string[]>("run_experiments.previous_evidence_artifact_backups");
    expect(evidenceBackups).toHaveLength(2);
    expect(evidenceBackups?.every((backup) => backup.includes("preexisting_artifacts_raw_evaluation_evidence"))).toBe(true);
    const backedUpEvidence = await Promise.all(evidenceBackups!.map((backup) => readFile(backup, "utf8")));
    expect(backedUpEvidence.join("\n")).toContain("old stale diagnostic");
    expect(backedUpEvidence.join("\n")).toContain("old public stale diagnostic");
  });

  it("recovers only explicitly selected Results V2 metrics from a completed public bundle", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-recover-public-completed-metrics-"));
    process.chdir(root);
    const run = makeRun("run-recover-public-completed-metrics");
    run.objectiveMetric = "outcome_measure >= 0.9";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    const publicDir = path.join(root, "public");
    const metricsPath = path.join(runDir, "metrics.json");
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(publicDir, { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.public_dir", publicDir);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await mkdir(path.dirname(metricsPath), { recursive: true });
          await writeFile(
            metricsPath,
            JSON.stringify(
              {
                status: "failed",
                error: "stale failed run metrics"
              },
              null,
              2
            ),
            "utf8"
          );
          await writeFile(
            path.join(publicDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                success: true,
                ...buildExplicitResultsV2Fixture({
                  metricId: "outcome_measure",
                  primaryValue: 0.95
                }),
                completed_condition_count: 1,
                required_condition_count: 1
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "ok" as const, stdout: "completed", stderr: "", exit_code: 0, duration_ms: 5 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    const recoveredMetrics = JSON.parse(await readFile(metricsPath, "utf8")) as {
      status?: string;
      outcome_measure?: number;
      primary_observation_id?: string;
    };
    expect(recoveredMetrics).toMatchObject({
      status: "completed",
      outcome_measure: 0.95,
      primary_observation_id: "observation-primary"
    });
    await expect(runContext.get("run_experiments.recovered_public_metrics_path")).resolves.toBe(
      path.join(publicDir, "metrics.json")
    );
  });

  it("forwards timeout flags through shell wrappers that pass through argv", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-shell-timeout-"));
    process.chdir(root);
    const run = makeRun("run-shell-wrapper-timeout");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const scriptPath = path.join(root, "run_condition_sweep_experiment.py");
    const wrapperPath = path.join(root, "run_command.sh");
    await writeFile(
      scriptPath,
      [
        "import argparse",
        "from pathlib import Path",
        "",
        "def parse_args(argv=None):",
        "    parser = argparse.ArgumentParser()",
        "    parser.add_argument('--metrics-path', default='metrics.json')",
        "    parser.add_argument('--timeout-sec', dest='timeout_sec', type=int, default=0)",
        "    return parser.parse_args(argv)",
        "",
        "if __name__ == '__main__':",
        "    args = parse_args()",
        "    Path(args.metrics_path).write_text('{\"status\":\"completed\",\"success\":true}', encoding='utf8')",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      wrapperPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "SCRIPT_DIR=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")\" && pwd)\"",
        "RUNNER=\"${SCRIPT_DIR}/run_condition_sweep_experiment.py\"",
        "exec \"${PYTHON_BIN:-python3}\" \"$RUNNER\" \"$@\"",
        ""
      ].join("\n"),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", `bash ${JSON.stringify(wrapperPath)}`);
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.script", scriptPath);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: { experiments: { timeout_sec: 43200 } } as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async (command: string) => {
          expect(command).toContain("--timeout-sec 43200");
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify({
              status: "completed",
              success: true,
              primary_metric: { name: "outcome_measure", value: 0.02, target: 0.01, met: true },
              condition_results: [{ condition_id: "baseline_condition", status: "completed", accuracy: 0.4 }],
              completed_condition_count: 1
            }),
            "utf8"
          );
          return { status: "ok" as const, stdout: "done", stderr: "", exit_code: 0, duration_ms: 1 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    await node.execute({ run, graph: run.graph });
  });
  it("does not let the live-validation helper timeout override runner timeout flags", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-timeout-env-separation-"));
    process.chdir(root);
    const run = makeRun("run-timeout-env-separation");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const scriptPath = path.join(root, "experiment.py");
    await writeFile(
      scriptPath,
      [
        "import argparse",
        "def main(argv=None):",
        "    parser = argparse.ArgumentParser()",
        "    parser.add_argument(\"--metrics-path\", default=\"metrics.json\")",
        "    parser.add_argument(\"--timeout-sec\", type=int, default=0)",
        "    return parser.parse_args(argv)",
        ""
      ].join("\n"),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 " + JSON.stringify(scriptPath));
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.script", scriptPath);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    const originalValidationTimeout = process.env.AUTOLABOS_VALIDATION_NEXT_TIMEOUT_SEC;
    process.env.AUTOLABOS_VALIDATION_NEXT_TIMEOUT_SEC = "9876";
    let observedCommand = "";
    try {
      const node = createRunExperimentsNode({
        config: {
          experiments: {
            timeout_sec: 1234,
            network_policy: "blocked"
          }
        } as any,
        executionProfile: "local",
        runStore: {} as any,
        eventStream: new InMemoryEventStream(),
        llm: new MockLLMClient(),
        experimentLlm: new MockLLMClient(),
        pdfTextLlm: new MockLLMClient(),
        codex: {} as any,
        aci: {
          runCommand: async (command: string) => {
            observedCommand = command;
            await writeFile(
              path.join(runDir, "metrics.json"),
              JSON.stringify(
                {
                  status: "completed",
                  success: true,
                  primary_metric: {
                    name: "outcome_measure",
                    value: 0.02,
                    target: 0.01,
                    met: true
                  },
                  condition_results: [
                    { condition_id: "baseline_condition", status: "completed", accuracy: 0.4 },
                    { condition_id: "candidate_condition_a", status: "completed", accuracy: 0.42 }
                  ],
                  completed_condition_count: 2
                },
                null,
                2
              ),
              "utf8"
            );
            return {
              status: "ok" as const,
              stdout: "runner completed",
              stderr: "",
              exit_code: 0,
              duration_ms: 10
            };
          },
          runTests: async () => ({
            status: "ok" as const,
            stdout: "",
            stderr: "",
            exit_code: 0,
            duration_ms: 1
          })
        } as any,
        semanticScholar: {} as any,
        openAlex: {} as any,
        crossref: {} as any,
        arxiv: {} as any,
        responsesPdfAnalysis: {} as any
      });

      await node.execute({ run, graph: run.graph });
    } finally {
      if (originalValidationTimeout === undefined) {
        delete process.env.AUTOLABOS_VALIDATION_NEXT_TIMEOUT_SEC;
      } else {
        process.env.AUTOLABOS_VALIDATION_NEXT_TIMEOUT_SEC = originalValidationTimeout;
      }
    }

    expect(observedCommand).toContain("--timeout-sec 1234");
    expect(observedCommand).not.toContain("--timeout-sec 9876");
  });

  it("appends per-condition timeout when accepted by the Python runner", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-condition-timeout-"));
    process.chdir(root);
    const run = makeRun("run-condition-timeout");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const scriptPath = path.join(root, "experiment.py");
    await writeFile(
      scriptPath,
      [
        "import argparse",
        "def main(argv=None):",
        "    parser = argparse.ArgumentParser()",
        "    parser.add_argument('--metrics-path', default='metrics.json')",
        "    parser.add_argument('--timeout-sec', type=int, default=0)",
        "    parser.add_argument('--condition-timeout-sec', type=int, default=0)",
        "    return parser.parse_args(argv)",
        ""
      ].join("\n"),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 " + JSON.stringify(scriptPath));
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.script", scriptPath);
    await runContext.put("implement_experiments.metrics_path", ".autolabos/runs/" + run.id + "/metrics.json");

    let observedCommand = "";
    const node = createRunExperimentsNode({
      config: {
        experiments: {
          timeout_sec: 1234,
          network_policy: "blocked"
        }
      } as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async (command: string) => {
          observedCommand = command;
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                success: true,
                primary_metric: {
                  name: "outcome_measure",
                  value: 0.02,
                  target: 0.01,
                  met: true
                },
                condition_results: [
                  { condition_id: "baseline_condition", status: "completed", accuracy: 0.4 },
                  { condition_id: "candidate_condition_a", status: "completed", accuracy: 0.42 }
                ],
                completed_condition_count: 2
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner completed",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    await node.execute({ run, graph: run.graph });

    expect(observedCommand).toContain("--timeout-sec 1234");
    expect(observedCommand).toContain("--condition-timeout-sec 1234");
  });

  it("does not append timeout flags only mentioned outside argparse", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-timeout-flag-source-mention-"));
    process.chdir(root);
    const run = makeRun("run-timeout-flag-source-mention");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const scriptPath = path.join(root, "experiment.py");
    await writeFile(
      scriptPath,
      [
        "import argparse",
        "TIMEOUT_FLAG = '--timeout-sec'",
        "def main(argv=None):",
        "    parser = argparse.ArgumentParser()",
        "    parser.add_argument('--output-dir', default='.')",
        "    parser.add_argument('--metrics-path', default='metrics.json')",
        "    return parser.parse_args(argv)",
        ""
      ].join("\n"),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", `python3 ${JSON.stringify(scriptPath)}`);
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.script", scriptPath);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    let observedCommand = "";
    const node = createRunExperimentsNode({
      config: {
        experiments: {
          timeout_sec: 14400,
          network_policy: "blocked"
        }
      } as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async (command: string) => {
          observedCommand = command;
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                success: true,
                primary_metric: {
                  name: "outcome_measure",
                  value: 0.02,
                  target: 0.01,
                  met: true
                },
                condition_results: [
                  { condition_id: "baseline_condition", status: "completed", accuracy: 0.4 },
                  { condition_id: "candidate_condition_a", status: "completed", accuracy: 0.42 }
                ],
                completed_condition_count: 2
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner completed",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    await node.execute({ run, graph: run.graph });

    expect(observedCommand).not.toContain("--timeout-sec 14400");
    expect(observedCommand).not.toContain("--budget-timeout-sec 14400");
  });

  it("does not append timeout flags accepted only by a fallback parser", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-timeout-fallback-parser-"));
    process.chdir(root);
    const run = makeRun("run-timeout-fallback-parser");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const scriptPath = path.join(root, "experiment.py");
    await writeFile(
      scriptPath,
      [
        "import argparse",
        "def build_arg_parser():",
        "    parser = argparse.ArgumentParser()",
        "    parser.add_argument('--output-dir', default='.')",
        "    parser.add_argument('--metrics-path', default='metrics.json')",
        "    return parser",
        "def _fallback_arg_parser():",
        "    parser = argparse.ArgumentParser()",
        "    parser.add_argument('--timeout-sec', type=int, default=None)",
        "    return parser",
        "def main(argv=None):",
        "    return build_arg_parser().parse_args(argv)",
        ""
      ].join("\n"),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", `python3 ${JSON.stringify(scriptPath)}`);
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.script", scriptPath);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    let observedCommand = "";
    const node = createRunExperimentsNode({
      config: {
        experiments: {
          timeout_sec: 14400,
          network_policy: "blocked"
        }
      } as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async (command: string) => {
          observedCommand = command;
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                success: true,
                primary_metric: {
                  name: "outcome_measure",
                  value: 0.02,
                  target: 0.01,
                  met: true
                },
                condition_results: [
                  { condition_id: "baseline_condition", status: "completed", accuracy: 0.4 },
                  { condition_id: "candidate_condition_a", status: "completed", accuracy: 0.42 }
                ],
                completed_condition_count: 2
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner completed",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    await node.execute({ run, graph: run.graph });

    expect(observedCommand).not.toContain("--timeout-sec 14400");
    expect(observedCommand).not.toContain("--budget-timeout-sec 14400");
  });

  it("promotes only an explicitly selected Results V2 observation", async () => {
    const { result, metrics } = await executeMeaningPreservationFixture({
      runId: "run-explicit-observation-promotion",
      objectiveMetric: "outcome_measure >= -1",
      metrics: {
        status: "completed",
        success: true,
        ...buildExplicitResultsV2Fixture({
          metricId: "outcome_measure",
          direction: "higher_better",
          primaryValue: -0.03125
        })
      }
    });

    expect(result.status).toBe("success");
    expect(metrics.outcome_measure).toBe(-0.03125);
    expect(metrics.primary_metric_key).toBe("outcome_measure");
    expect(metrics.primary_metric_value).toBe(-0.03125);
    expect(metrics.primary_metric_direction).toBe("higher_better");
    expect(metrics.primary_observation_id).toBe("observation-primary");
  });

  it("preserves an explicit Results V2 comparison without selecting an aggregate winner", async () => {
    const { result, metrics } = await executeMeaningPreservationFixture({
      runId: "run-explicit-comparison-promotion",
      objectiveMetric: "outcome_measure >= 0.6",
      metrics: {
        status: "completed",
        success: true,
        ...buildExplicitResultsV2Fixture({
          metricId: "outcome_measure",
          primaryValue: 0.62,
          referenceValue: 0.6,
          comparisonDelta: 0.02
        }),
        aggregate: {
          completed_run_count: 6,
          required_run_count: 6,
          completed_condition_count: 2,
          required_condition_count: 2,
          failed_run_count: 0
        }
      }
    });

    expect(result.status).toBe("success");
    expect(metrics.outcome_measure).toBeCloseTo(0.62, 8);
    expect(metrics.primary_observation_id).toBe("observation-primary");
    expect(metrics.primary_comparison_id).toBe("comparison-primary-reference");
    expect(metrics.results_artifact.comparisons).toEqual([
      expect.objectContaining({
        id: "comparison-primary-reference",
        subject_observation_id: "observation-primary",
        reference_observation_id: "observation-reference",
        delta: 0.02
      })
    ]);
    expect(metrics.completed_run_count).toBe(6);
    expect(metrics.required_run_count).toBe(6);
    expect(metrics.completed_condition_count).toBe(2);
    expect(metrics.required_condition_count).toBe(2);
  });

  it("projects explicit boolean outcomes with Wilson evidence and no comparison", async () => {
    const rows = [
      ["series-reference", "baseline", "partition-alpha", "item-1", true],
      ["series-reference", "baseline", "partition-alpha", "item-2", false],
      ["series-reference", "baseline", "partition-beta", "item-3", true],
      ["series-reference", "baseline", "partition-beta", "item-4", false],
      ["series-primary", "primary", "partition-alpha", "item-1", true],
      ["series-primary", "primary", "partition-alpha", "item-2", true],
      ["series-primary", "primary", "partition-beta", "item-3", true],
      ["series-primary", "primary", "partition-beta", "item-4", false]
    ].map(([condition_marker, role, task, example_id, correct]) => ({
      condition_marker,
      role,
      task,
      example_id,
      correct,
      metric_id: "binary_outcome_rate",
      metric_direction: "higher_better",
      metric_unit: "unitless",
      status: "completed"
    }));

    const { result, metrics } = await executeMeaningPreservationFixture({
      runId: "run-explicit-boolean-outcomes",
      objectiveMetric: "binary_outcome_rate >= 0",
      metrics: {
        status: "completed",
        success: true,
        metric_definitions: [
          { id: "binary_outcome_rate", label: "Binary outcome rate", direction: "higher_better", unit: "unitless" }
        ],
        raw_condition_results: rows
      }
    });

    expect(result.status).toBe("success");
    expect(metrics.binary_outcome_rate).toBeCloseTo(0.75, 8);
    expect(metrics.results_artifact.comparisons).toEqual([]);
    const referenceObservation = metrics.results_artifact.observations.find(
      (item: Record<string, any>) =>
        item.series_id === "series-reference" && item.scope?.aggregation === "pooled_binary_count"
    );
    const primaryObservation = metrics.results_artifact.observations.find(
      (item: Record<string, any>) =>
        item.series_id === "series-primary" && item.scope?.aggregation === "pooled_binary_count"
    );
    expect(referenceObservation?.value).toBeCloseTo(0.5, 8);
    expect(primaryObservation?.value).toBeCloseTo(0.75, 8);
    expect(metrics.confidence_intervals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ observation_id: referenceObservation?.id, sample_size: 4 }),
        expect.objectContaining({ observation_id: primaryObservation?.id, sample_size: 4 })
      ])
    );
  });

  it("does not promote named condition rows without an explicit Results V2 selection", async () => {
    const { result, metrics } = await executeMeaningPreservationFixture({
      runId: "run-name-only-condition-payload",
      objectiveMetric: "outcome_measure >= 0",
      metrics: {
        status: "completed",
        success: true,
        primary_metric_key: "outcome_measure",
        primary_metric_value: null,
        outcome_measure: null,
        primary_condition_marker: "series-primary",
        condition_summaries: [
          {
            condition_marker: "series-reference",
            role: "baseline",
            outcome_measure: 0.2
          },
          {
            condition_marker: "series-primary",
            role: "primary",
            outcome_measure: 0.8
          }
        ]
      }
    });

    expect(result.status).toBe("failure");
    expect(metrics.outcome_measure).toBeNull();
    expect(metrics.primary_metric_value).toBeNull();
    expect(metrics.primary_observation_id).toBeUndefined();
    expect(metrics.results_artifact).toBeUndefined();
  });

  it("publishes canonical public summaries from accepted run metrics instead of stale runner summaries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-public-summary-sync-"));
    process.chdir(root);
    const run = makeRun("run-public-summary-sync");
    run.objectiveMetric = "quality_index >= 0";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    const publicExperimentDir = buildPublicSectionDir(root, run, "experiment");
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await mkdir(publicExperimentDir, { recursive: true });
    await writeFile(
      path.join(publicExperimentDir, "summary.json"),
      JSON.stringify({ status: "failed", completed_run_count: 0, required_run_count: 24 }, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(publicExperimentDir, "study_summary.json"),
      JSON.stringify({ status: "failed", completed_run_count: 0, required_run_count: 24 }, null, 2),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                quality_index: 0.95,
                completed_run_count: 24,
                required_run_count: 24,
                attempted_run_count: 24,
                failed_run_count: 0,
                completed_condition_count: 8,
                required_condition_count: 8,
                per_seed_rows: Array.from({ length: 8 }, (_unused, index) => `series-${index + 1}`).flatMap((marker) =>
                  [101, 202, 303].map((seed) => ({ condition_marker: marker, seed, status: "completed" }))
                )
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner completed",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    const publicSummary = JSON.parse(await readFile(path.join(publicExperimentDir, "summary.json"), "utf8")) as {
      source?: string;
      completed_run_count?: number;
      required_run_count?: number;
      failed_run_count?: number;
      primary_metric_key?: string | null;
      primary_observation?: Record<string, unknown> | null;
      results_artifact?: Record<string, unknown> | null;
    };
    const publicStudySummary = JSON.parse(
      await readFile(path.join(publicExperimentDir, "study_summary.json"), "utf8")
    ) as {
      source?: string;
      completed_run_count?: number;
      required_run_count?: number;
      completed_condition_count?: number;
    };
    expect(publicSummary).toMatchObject({
      source: "run_experiments",
      completed_run_count: 24,
      required_run_count: 24,
      failed_run_count: 0,
      primary_metric_key: null,
      primary_observation: null,
      results_artifact: null
    });
    expect(publicStudySummary).toMatchObject({
      source: "run_experiments",
      completed_run_count: 24,
      required_run_count: 24,
      completed_condition_count: 8
    });
  });

  it("classifies all-condition Hugging Face model load failures as dependency blockers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-model-dependency-blocker-"));
    process.chdir(root);
    const run = makeRun("run-model-dependency-blocker");
    run.objectiveMetric = "outcome_measure";
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "completed",
                condition_results: [
                  {
                    condition_id: "unmodified_base",
                    status: "failed",
                    error:
                      "OSError: Can't load the configuration of 'EleutherAI/pythia-410m'. If you were trying to load it from Hugging Face, make sure the model is available or cached locally."
                  },
                  {
                    condition_id: "reference_candidate",
                    status: "failed",
                    evidence: {
                      error_message:
                        "OSError: Can't load the configuration of 'EleutherAI/pythia-410m'. AutoModelForCausalLM.from_pretrained failed."
                    }
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner wrote dependency-failed metrics",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment dependency blocker");
    expect(result.error).toContain("EleutherAI/pythia-410m");
    expect(result.error).toContain("No condition metrics were accepted as evidence");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string; suggested_next_action?: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("Experiment dependency blocker");
  });

  it("fails verification when comparator recipes report failed statuses inside otherwise ok metrics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-failed-recipes-"));
    process.chdir(root);
    const run = makeRun("run-failed-recipes");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "ok",
                primary_metric: {
                  name: "mean_zero_shot_accuracy",
                  absolute_improvement_over_baseline: 0
                },
                recipes: {
                  baseline: {
                    status: "ok",
                    evaluation: {
                      mean_zero_shot_accuracy: 0.4
                    }
                  },
                  condition_parameter_x4: {
                    status: "failed",
                    error: "TrainingArguments.__init__() got an unexpected keyword argument 'overwrite_output_dir'"
                  }
                }
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner wrote partial metrics",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment metrics payload reports failed recipe(s)");
    expect(result.error).toContain("condition_parameter_x4");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("Experiment metrics payload reports failed recipe(s)");
  });

  it("fails verification when a required run contract exits zero with no completed runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-zero-completed-"));
    process.chdir(root);
    const run = makeRun("run-zero-completed");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "success",
                accuracy: 0.95,
                required_condition_count: 5,
                completed_condition_count: 0,
                required_run_count: 25,
                completed_run_count: 0,
                failure_count: 2,
                seed_results: [
                  {
                    status: "failed",
                    error_type: "RuntimeError",
                    error_stage: "execution",
                    error_message: "No seed execution helper was found in the current runner module."
                  },
                  {
                    status: "failed",
                    error_type: "RuntimeError",
                    error_stage: "execution",
                    error_message: "No seed execution helper was found in the current runner module."
                  }
                ],
                study_summary: {
                  status: "failed",
                  required_run_count: 25,
                  completed_run_count: 0
                }
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner exited zero after failed condition loop",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("No required experiment runs completed successfully");
    expect(result.error).toContain("No seed execution helper was found in the current runner module");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("No required experiment runs completed successfully");
    expect(verifierReport.summary).toContain("seed_failure_messages=RuntimeError: stage=execution");
  });

  it("surfaces nested backend discovery failures from rejected metrics payloads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-nested-backend-failure-"));
    process.chdir(root);
    const run = makeRun("run-nested-backend-failure");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "failed",
                primary_metric: {
                  key: "outcome_measure",
                  value: null
                },
                aggregates: {
                  completed_run_count: 0,
                  failed_run_count: 2
                },
                backend: {
                  status: "not_found",
                  attempts: [
                    {
                      candidate: "backend_candidate_a",
                      error: "ModuleNotFoundError: No module named backend_candidate_a",
                      status: "failed"
                    }
                  ]
                },
                raw_results: [
                  {
                    condition_marker: "baseline_condition",
                    status: "failed",
                    error_message: "No supported backend module discovered: not_found"
                  }
                ],
                condition_summaries: [
                  {
                    marker: "baseline_condition",
                    completed_run_count: 0,
                    status: "failed",
                    seed_results: [
                      {
                        seed: 1,
                        status: "failed",
                        error_message: "No supported backend module discovered: not_found"
                      }
                    ]
                  }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner wrote failed metrics payload",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("No supported backend module discovered: not_found");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("metrics_error_messages=ModuleNotFoundError");
    expect(verifierReport.summary).toContain("seed_failure_messages=No supported backend module discovered: not_found");
  });

  it("fails verification when planned run coverage is contracted below the portfolio evidence floor", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-contracted-coverage-"));
    process.chdir(root);
    const run = makeRun("run-contracted-coverage");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await writeFile(
      path.join(runDir, "experiment_portfolio.json"),
      JSON.stringify(
        {
          version: 1,
          run_id: run.id,
          created_at: new Date().toISOString(),
          execution_model: "single_run",
          comparison_axes: ["condition_parameter_x"],
          primary_trial_group_id: "primary",
          total_expected_trials: 22,
          trial_groups: [
            {
              id: "primary",
              label: "Primary repeated execution group",
              role: "primary",
              group_kind: "aggregate",
              dataset_scope: ["partition-alpha", "partition-beta"],
              metrics: ["outcome_measure"],
              baselines: ["series-reference"],
              expected_trials: 22,
              notes: ["The governed execution schedule explicitly requires 22 trials."]
            }
          ]
        },
        null,
        2
      ),
      "utf8"
    );

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "success",
                accuracy: 0.95,
                outcome_measure: 0,
                completed_run_count: 4,
                completed_condition_count: 4,
                condition_summaries: [
                  { condition_marker: "baseline_condition", completed_runs: 1 },
                  { condition_marker: "candidate_condition_a", completed_runs: 1 },
                  { condition_marker: "candidate_condition_d", completed_runs: 1 },
                  { condition_marker: "candidate_condition_f", completed_runs: 1 }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return {
            status: "ok" as const,
            stdout: "runner exited zero with a smoke-scale contracted run",
            stderr: "",
            exit_code: 0,
            duration_ms: 10
          };
        },
        runTests: async () => ({
          status: "ok" as const,
          stdout: "",
          stderr: "",
          exit_code: 0,
          duration_ms: 1
        })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment run coverage incomplete: completed_run_count=4/22");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("completed_run_count=4/22");
  });

  it("fails repeated-run verification when completed counters lack condition-seed evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-seed-evidence-"));
    process.chdir(root);
    const run = makeRun("run-seed-evidence");
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    await mkdir(path.join(runDir, "memory"), { recursive: true });

    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    await runContext.put("implement_experiments.run_command", "python3 experiment.py");
    await runContext.put("implement_experiments.cwd", root);
    await runContext.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const node = createRunExperimentsNode({
      config: {} as any,
      executionProfile: "local",
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      experimentLlm: new MockLLMClient(),
      pdfTextLlm: new MockLLMClient(),
      codex: {} as any,
      aci: {
        runCommand: async () => {
          await writeFile(
            path.join(runDir, "metrics.json"),
            JSON.stringify(
              {
                status: "success",
                success: true,
                outcome_measure: 0.12,
                primary_metric_key: "outcome_measure",
                primary_metric_value: 0.12,
                completed_run_count: 6,
                required_run_count: 6,
                completed_condition_count: 2,
                required_condition_count: 2,
                run_config: { seeds: [101, 202, 303] },
                condition_results: [
                  { condition_marker: "baseline_condition", status: "completed", seed_count: 0, seeds: [] },
                  { condition_marker: "candidate_condition_a", status: "completed", seed_count: 0, seeds: [] }
                ]
              },
              null,
              2
            ),
            "utf8"
          );
          return { status: "ok" as const, stdout: "runner exited zero", stderr: "", exit_code: 0, duration_ms: 10 };
        },
        runTests: async () => ({ status: "ok" as const, stdout: "", stderr: "", exit_code: 0, duration_ms: 1 })
      } as any,
      semanticScholar: {} as any,
      openAlex: {} as any,
      crossref: {} as any,
      arxiv: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Explicit seed schedule (3 seeds) requires seed provenance");

    const verifierReport = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_verify_report.json"), "utf8")
    ) as { status: string; stage: string; summary: string };
    expect(verifierReport).toMatchObject({
      status: "fail",
      stage: "metrics"
    });
    expect(verifierReport.summary).toContain("Explicit seed schedule (3 seeds) requires seed provenance");
  });
  it("preserves arbitrary per-example scores without projecting binary outcomes", async () => {
    const { result, metrics } = await executeMeaningPreservationFixture({
      runId: "run-generic-score-observation",
      metrics: {
        status: "completed",
        success: true,
        primary_metric_key: "quality_index",
        primary_metric_value: 0.7,
        quality_index: 0.7,
        condition_results: [
          {
            condition_marker: "reference_condition",
            task: "validation_partition",
            example_id: "example_reference",
            status: "completed",
            score: 0.2
          },
          {
            condition_marker: "selected_condition",
            task: "validation_partition",
            example_id: "example_selected",
            status: "completed",
            score: 0.9
          }
        ]
      }
    });

    expect(result.status).toBe("success");
    expect(metrics.condition_results.map((row: Record<string, unknown>) => row.score)).toEqual([0.2, 0.9]);
    expect(metrics.condition_summaries).toBeUndefined();
    expect(metrics.confidence_intervals).toBeUndefined();
    expect(metrics.outcome_measure).toBeUndefined();
    expect(metrics.results_artifact).toBeUndefined();
    expect(metrics.run_experiments_diagnostics).toContainEqual(
      expect.objectContaining({ code: "per_example_projection_skipped_ambiguous_metric_semantics" })
    );
  });

  it("does not assign series roles from labels or observed values", async () => {
    const { result, metrics } = await executeMeaningPreservationFixture({
      runId: "run-label-role-spoof",
      objectiveMetric: "outcome_rate >= 0",
      metrics: {
        status: "completed",
        success: true,
        metric_definitions: [
          { id: "outcome_rate", label: "Outcome rate", direction: "higher_better", unit: "unitless" }
        ],
        condition_results: [
          {
            condition_marker: "series-alpha",
            label: "baseline",
            task: "validation-partition",
            example_id: "item-alpha",
            status: "completed",
            correct: false,
            metric_id: "outcome_rate",
            metric_direction: "higher_better",
            metric_unit: "unitless"
          },
          {
            condition_marker: "series-beta",
            label: "primary",
            task: "validation-partition",
            example_id: "item-beta",
            status: "completed",
            correct: true,
            metric_id: "outcome_rate",
            metric_direction: "higher_better",
            metric_unit: "unitless"
          }
        ]
      }
    });

    expect(result.status).toBe("failure");
    expect(metrics.results_artifact.series.every((item: Record<string, unknown>) => item.role === undefined)).toBe(true);
    expect(metrics.results_artifact.comparisons).toEqual([]);
    expect(metrics.results_selection).toBeUndefined();
    expect(metrics.run_experiments_diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "comparison_projection_skipped_ambiguous_series_roles" }),
        expect.objectContaining({ code: "results_v2_selection_missing" })
      ])
    );
  });

  it("rejects multiple series that declare the primary role", async () => {
    const { result, metrics } = await executeMeaningPreservationFixture({
      runId: "run-ambiguous-primary-role",
      objectiveMetric: "outcome_rate >= 0",
      metrics: {
        status: "completed",
        success: true,
        metric_definitions: [
          { id: "outcome_rate", label: "Outcome rate", direction: "higher_better", unit: "unitless" }
        ],
        results_selection: { metric_id: "outcome_rate" },
        condition_results: [
          {
            condition_marker: "series-reference",
            role: "baseline",
            status: "completed",
            correct: false,
            metric_id: "outcome_rate",
            metric_direction: "higher_better",
            metric_unit: "unitless"
          },
          {
            condition_marker: "series-primary-a",
            role: "primary",
            status: "completed",
            correct: true,
            metric_id: "outcome_rate",
            metric_direction: "higher_better",
            metric_unit: "unitless"
          },
          {
            condition_marker: "series-primary-b",
            role: "primary",
            status: "completed",
            correct: true,
            metric_id: "outcome_rate",
            metric_direction: "higher_better",
            metric_unit: "unitless"
          }
        ]
      }
    });

    expect(result.status).toBe("failure");
    expect(metrics.results_artifact.series.filter(
      (item: Record<string, unknown>) => item.role === "primary"
    )).toHaveLength(2);
    expect(metrics.results_artifact.comparisons).toEqual([]);
    expect(metrics.run_experiments_diagnostics).toContainEqual(
      expect.objectContaining({ code: "results_v2_selection_rejected_ambiguous_primary_series" })
    );
  });

  it("preserves a unique explicit baseline and primary role pair", async () => {
    const { result, metrics } = await executeMeaningPreservationFixture({
      runId: "run-explicit-role-pair",
      objectiveMetric: "outcome_rate >= 0",
      metrics: {
        status: "completed",
        success: true,
        metric_definitions: [
          { id: "outcome_rate", label: "Outcome rate", direction: "higher_better", unit: "unitless" }
        ],
        condition_results: [
          {
            condition_marker: "series-reference",
            role: "baseline",
            status: "completed",
            correct: false,
            metric_id: "outcome_rate",
            metric_direction: "higher_better",
            metric_unit: "unitless"
          },
          {
            condition_marker: "series-primary",
            role: "primary",
            status: "completed",
            correct: true,
            metric_id: "outcome_rate",
            metric_direction: "higher_better",
            metric_unit: "unitless"
          }
        ]
      }
    });

    expect(result.status).toBe("success");
    expect(metrics.results_artifact.series).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "series-reference", role: "baseline" }),
        expect.objectContaining({ id: "series-primary", role: "primary" })
      ])
    );
    expect(metrics.results_artifact.comparisons).toEqual([]);
    expect(metrics.results_selection).toMatchObject({
      metric_id: "outcome_rate",
      primary_observation_id: "series-primary::outcome_rate::pooled"
    });
    expect(metrics.outcome_rate).toBe(1);
  });

  it("fails closed when a managed artifact comparison omits explicit series roles", async () => {
    const runId = "run-matrix-ambiguous-roles";
    const fixture = buildExplicitResultsV2Fixture({
      metricId: "quality_index",
      primaryValue: 0.7,
      referenceValue: 0.4,
      comparisonDelta: 0.3,
      scope: { dataset: "validation_partition" }
    }) as any;
    const roleAmbiguousArtifact = {
      ...fixture.results_artifact,
      series: fixture.results_artifact.series.map(({ role: _role, ...series }: Record<string, unknown>) => series)
    };
    const { result } = await executeMeaningPreservationFixture({
      runId,
      portfolio: buildManagedMeaningPreservationPortfolio(runId),
      metrics: {
        status: "completed",
        success: true,
        quality_index: 0.7,
        results_artifact: roleAmbiguousArtifact
      }
    });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("requires subject series role primary or comparator");
    expect(result.error).toContain("requires reference series role baseline");
  });

  it("does not divide aggregate trial counts across explicit Results V2 matrix slices", async () => {
    const runId = "run-matrix-explicit-sampling-only";
    const { result, runDir } = await executeMeaningPreservationFixture({
      runId,
      portfolio: buildManagedMeaningPreservationPortfolio(runId),
      metrics: {
        status: "completed",
        success: true,
        ...buildExplicitResultsV2Fixture({
          metricId: "quality_index",
          primaryValue: 0.7,
          referenceValue: 0.4,
          comparisonDelta: 0.3,
          scope: { dataset: "validation_partition" }
        }),
        sampling_profile: {
          name: "aggregate_execution",
          total_trials: 12,
          executed_trials: 12
        }
      }
    });

    expect(result.status).toBe("success");
    const matrixRecords = JSON.parse(
      await readFile(path.join(runDir, "run_experiments_matrix_trial_groups.json"), "utf8")
    ) as Array<{ status: string; metrics_path?: string; sampling_profile?: Record<string, unknown> }>;
    expect(matrixRecords[0].status).toBe("pass");
    expect(matrixRecords[0].sampling_profile).toBeUndefined();
    const sliceMetrics = JSON.parse(await readFile(String(matrixRecords[0].metrics_path), "utf8")) as {
      sampling_profile?: Record<string, unknown>;
      comparison?: Record<string, unknown>;
    };
    expect(sliceMetrics.sampling_profile).toBeUndefined();
    expect(sliceMetrics.comparison).toMatchObject({
      id: "comparison-primary-reference",
      metric_id: "quality_index",
      metric_direction: "higher_better",
      delta: 0.3
    });
  });

  it("rejects an ambiguous portfolio instead of falling back to the first trial group", async () => {
    const runId = "run-portfolio-primary-ambiguity";
    const portfolio = buildManagedMeaningPreservationPortfolio(runId);
    delete portfolio.primary_trial_group_id;
    portfolio.trial_groups = portfolio.trial_groups
      .filter((group: Record<string, unknown>) => group.group_kind !== "matrix_slice")
      .map((group: Record<string, unknown>) => ({ ...group, role: "supplemental" }));
    portfolio.trial_groups.push({
      id: "alternate_group",
      label: "Alternate aggregate group",
      role: "supplemental",
      group_kind: "aggregate",
      dataset_scope: ["held_out_partition"],
      metrics: ["quality_index"],
      baselines: [],
      notes: []
    });

    const { result } = await executeMeaningPreservationFixture({
      runId,
      portfolio,
      metrics: {
        status: "completed",
        success: true,
        primary_metric_key: "quality_index",
        primary_metric_value: 0.7,
        quality_index: 0.7
      }
    });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Experiment portfolio primary trial group is ambiguous");
    expect(result.error).toContain("no aggregate trial group declared role=primary");
  });

  it("does not infer a Cartesian seed schedule from required run and condition counts", async () => {
    const { result, metrics } = await executeMeaningPreservationFixture({
      runId: "run-no-cartesian-seed-inference",
      metrics: {
        status: "completed",
        success: true,
        primary_metric_key: "quality_index",
        primary_metric_value: 0.7,
        quality_index: 0.7,
        completed_run_count: 6,
        required_run_count: 6,
        completed_condition_count: 2,
        required_condition_count: 2,
        condition_results: [
          { condition_marker: "reference_condition", status: "completed", seeds: [], seed_count: 0 },
          { condition_marker: "selected_condition", status: "completed", seeds: [], seed_count: 0 }
        ]
      }
    });

    expect(result.status).toBe("success");
    expect(metrics.run_experiments_diagnostics).toBeUndefined();
  });

  it("preserves distinct failure codes and reasons in a bounded summary", async () => {
    const { result } = await executeMeaningPreservationFixture({
      runId: "run-distinct-failure-summary",
      metrics: {
        status: "failed",
        success: false,
        failures: [
          { failure_code: "reference_unavailable", failure_reason: "Reference execution was unavailable." },
          { failure_code: "evaluation_timeout", failure_reason: "Evaluation exceeded its declared timeout." }
        ]
      }
    });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("failure_codes=reference_unavailable,evaluation_timeout");
    expect(result.error).toContain("reason=Reference execution was unavailable.");
    expect(result.error).toContain("reason=Evaluation exceeded its declared timeout.");
  });

  it("does not copy unmatched raw failure evidence into another condition summary", async () => {
    const { result, metrics } = await executeMeaningPreservationFixture({
      runId: "run-unmatched-raw-condition-evidence",
      rawConditionEvidenceRows: [
        {
          condition_id: "reference_condition",
          status: "failed",
          failure_reason: "Reference condition stopped before evaluation.",
          failure_stage: "evaluation"
        }
      ],
      metrics: {
        status: "completed",
        success: true,
        primary_metric_key: "quality_index",
        primary_metric_value: 0.7,
        quality_index: 0.7,
        raw_condition_results_path: "raw_condition_evidence.jsonl",
        condition_results: [
          { condition_id: "selected_condition", role: "primary", status: "completed" }
        ]
      }
    });

    expect(result.status).toBe("success");
    expect(metrics.condition_results[0].failure_reason).toBeUndefined();
    expect(metrics.condition_results[0].failure_stage).toBeUndefined();
    expect(metrics.run_experiments_diagnostics).toContainEqual(
      expect.objectContaining({
        code: "raw_condition_evidence_enrichment_skipped_unmatched_condition"
      })
    );
  });

  it("does not select the first failure when one condition has distinct raw failures", async () => {
    const { result, metrics } = await executeMeaningPreservationFixture({
      runId: "run-distinct-raw-condition-failures",
      rawConditionEvidenceRows: [
        {
          condition_id: "selected_condition",
          status: "failed",
          failure_code: "input_unavailable",
          failure_reason: "The configured input was unavailable."
        },
        {
          condition_id: "selected_condition",
          status: "failed",
          failure_code: "evaluation_timeout",
          failure_reason: "Evaluation exceeded its declared timeout."
        }
      ],
      metrics: {
        status: "completed",
        success: true,
        primary_metric_key: "quality_index",
        primary_metric_value: 0.7,
        quality_index: 0.7,
        raw_condition_results_path: "raw_condition_evidence.jsonl",
        condition_results: [
          { condition_id: "selected_condition", role: "primary", status: "completed" }
        ]
      }
    });

    expect(result.status).toBe("success");
    expect(metrics.condition_results[0].failure_reason).toBeUndefined();
    const diagnostic = metrics.run_experiments_diagnostics.find(
      (item: Record<string, unknown>) =>
        item.code === "raw_condition_evidence_enrichment_skipped_ambiguous_failures"
    );
    expect(diagnostic?.message).toContain("code=input_unavailable");
    expect(diagnostic?.message).toContain("reason=The configured input was unavailable.");
    expect(diagnostic?.message).toContain("code=evaluation_timeout");
    expect(diagnostic?.message).toContain("reason=Evaluation exceeded its declared timeout.");
  });

  it("accepts a generic explicit comparison without undeclared aggregate aliases", async () => {
    const runId = "run-generic-comparison-contract";
    const objectiveMetric = "quality_index >= 0";
    const { result, metrics } = await executeMeaningPreservationFixture({
      runId,
      objectiveMetric,
      comparisonContract: {
        version: 1,
        run_id: runId,
        plan_id: "plan-generic-comparison",
        selected_hypothesis_ids: ["hypothesis-generic-comparison"],
        objective_metric_name: objectiveMetric,
        baseline_first_required: true,
        baseline_candidate_ids: ["series-reference"],
        comparison_mode: "baseline_first_locked",
        budget_profile: {
          mode: "single_run_locked",
          locked: true,
          timeout_sec: 7200
        },
        objective_profile: {
          source: "heuristic_fallback",
          raw: objectiveMetric,
          primaryMetric: "quality_index",
          preferredMetricKeys: ["quality_index"],
          direction: "maximize",
          threshold: 0,
          thresholdOperator: ">="
        },
        evaluator_contract_id: "evaluator-generic-comparison",
        created_at: new Date().toISOString()
      },
      metrics: {
        status: "completed",
        success: true,
        ...buildExplicitResultsV2Fixture({
          metricId: "quality_index",
          primaryValue: 0.7,
          referenceValue: 0.4,
          comparisonDelta: 0.3
        }),
        study: {
          aggregate: {
            all_conditions_succeeded: true
          }
        }
      }
    });

    expect(result.status).toBe("success");
    expect(metrics.quality_index).toBe(0.7);
    expect(metrics.primary_comparison_id).toBe("comparison-primary-reference");
  });

  it("rejects an explicit comparison whose recorded delta contradicts its observations", async () => {
    const { result } = await executeMeaningPreservationFixture({
      runId: "run-invalid-explicit-comparison",
      objectiveMetric: "quality_index >= 0",
      metrics: {
        status: "completed",
        success: true,
        ...buildExplicitResultsV2Fixture({
          metricId: "quality_index",
          primaryValue: 0.7,
          referenceValue: 0.5,
          comparisonDelta: 0.3
        })
      }
    });

    expect(result.status).toBe("failure");
    expect(result.error).toContain(
      "delta must equal subject value minus reference value"
    );
  });

  it("does not infer a seed repeat allowance from a strongest-condition label", async () => {
    const { result } = await executeMeaningPreservationFixture({
      runId: "run-no-label-seed-repeat-inference",
      briefRaw: [
        "# Research Brief",
        "## Allowed Budgeted Passes",
        "- Repeat runs for the baseline and strongest condition when runtime allows."
      ].join("\n"),
      metrics: {
        status: "completed",
        success: true,
        primary_metric_key: "quality_index",
        primary_metric_value: 0.7,
        quality_index: 0.7,
        run_config: { seeds: [7] },
        condition_results: [
          {
            condition_id: "reference_condition",
            status: "completed",
            planned_seed_count: 2
          },
          {
            condition_id: "selected_condition",
            status: "completed",
            planned_seed_count: 2
          }
        ]
      }
    });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("Primary seed contract expanded");
  });

function buildManagedMeaningPreservationPortfolio(runId: string): Record<string, any> {
  return {
    version: 1,
    run_id: runId,
    created_at: new Date().toISOString(),
    execution_model: "managed_bundle",
    comparison_axes: ["dataset"],
    primary_trial_group_id: "aggregate_group",
    trial_groups: [
      {
        id: "aggregate_group",
        label: "Configured aggregate group",
        role: "primary",
        group_kind: "aggregate",
        dataset_scope: ["validation_partition", "held_out_partition"],
        metrics: ["quality_index"],
        baselines: [],
        notes: []
      },
      {
        id: "validation_slice",
        label: "Validation partition slice",
        role: "supplemental",
        group_kind: "matrix_slice",
        source_trial_group_id: "aggregate_group",
        matrix_axes: { dataset: "validation_partition" },
        dataset_scope: ["validation_partition"],
        metrics: ["quality_index"],
        baselines: [],
        notes: []
      }
    ]
  };
}

});


function buildTopicProbeExecutionContract(
  runId: string
): ActiveTopicProbeContract {
  return buildTopicProbeLineageFixture({
    runId,
    researchCycle: 0,
    computeBudgetLimits: {
      bounded_probe: {
        max_gpu_hours: 2,
        max_concurrent_gpus: 1,
        max_trials: 10
      },
      confirmatory: {
        max_gpu_hours: 9,
        max_concurrent_gpus: 1,
        max_trials: 20
      }
    }
  }).activeContract;
}

function buildTopicProbeComparisonContract(
  runId: string
): Record<string, unknown> {
  return {
    version: 1,
    run_id: runId,
    plan_id: "plan_compute_fixture",
    selected_hypothesis_ids: ["hypothesis_compute_fixture"],
    objective_metric_name: "quality_index >= 0",
    baseline_first_required: false,
    baseline_candidate_ids: [],
    comparison_mode: "objective_only",
    budget_profile: {
      mode: "single_run_locked",
      locked: true,
      timeout_sec: 1,
      total_trials: 1
    },
    objective_profile: {
      source: "heuristic_fallback",
      raw: "quality_index >= 0",
      primaryMetric: "quality_index",
      preferredMetricKeys: ["quality_index"],
      direction: "maximize",
      threshold: 0,
      thresholdOperator: ">="
    },
    evaluator_contract_id: "evaluator_compute_fixture",
    created_at: "2026-01-01T00:00:00.000Z"
  };
}

const TOPIC_DISCOVERY_COMPUTE_BRIEF = [
  "# Research Brief",
  "",
  "## Research Mode",
  "topic_discovery",
  "",
  "## Topic",
  "A bounded comparison with auditable compute usage.",
  "",
  "## Allowed Budgeted Passes",
  '- Machine-readable compute ceiling: `{"bounded_probe":{"max_gpu_hours":2,"max_concurrent_gpus":1,"max_trials":10},"confirmatory":{"max_gpu_hours":9,"max_concurrent_gpus":1,"max_trials":20}}`'
].join("\n");

describe("run_experiments topic-probe compute governance", () => {
  it("writes a hash-chained usage ledger for a bounded GPU execution", async () => {
    const runId = "run-topic-compute-success";
    const { result, runDir } = await executeMeaningPreservationFixture({
      runId,
      briefRaw: TOPIC_DISCOVERY_COMPUTE_BRIEF,
      activeTopicProbeContract: buildTopicProbeExecutionContract(runId),
      comparisonContract: buildTopicProbeComparisonContract(runId),
      metrics: {
        status: "completed",
        success: true,
        quality_index: 0.7,
        ...buildExplicitResultsV2Fixture({
          metricId: "quality_index",
          primaryValue: 0.7,
          referenceValue: 0.4,
          comparisonDelta: 0.3
        }),
        compute_usage: {
          schema_version: 1,
          execution_kind: "gpu_execution",
          actual_gpu_count: 1,
          fresh_executed_trials: 1,
          cached_trials: 0
        }
      }
    });

    expect(result.status, JSON.stringify(result, null, 2)).toBe("success");
    const ledgerLines = (
      await readFile(
        path.join(
          runDir,
          "governance",
          "topic_probe_compute_usage_ledger.jsonl"
        ),
        "utf8"
      )
    ).trim().split("\n").map((line) => JSON.parse(line));
    expect(ledgerLines).toHaveLength(2);
    expect(ledgerLines[0]).toMatchObject({
      event_kind: "preflight_estimate",
      decision: "allowed",
      previous_entry_sha256: null
    });
    expect(ledgerLines[1]).toMatchObject({
      event_kind: "actual_usage",
      execution_kind: "gpu_execution",
      actual_gpu_count: 1,
      fresh_executed_trials: 1,
      within_budget: true,
      previous_entry_sha256: ledgerLines[0].content_sha256
    });
    const storedEvidenceBytes = await readFile(
      path.join(
        runDir,
        "governance",
        "topic_probe_compute_usage_evidence",
        "attempt_1.json"
      ),
      "utf8"
    );
    expect(storedEvidenceBytes.endsWith("\n")).toBe(true);
    expect(ledgerLines[1].usage_evidence_sha256).toBe(
      createHash("sha256").update(storedEvidenceBytes).digest("hex")
    );
    const executionEnvelope = JSON.parse(
      await readFile(
        path.join(runDir, "execution", "execution_envelope.json"),
        "utf8"
      )
    );
    expect(executionEnvelope.devices).toEqual({
      policy: "nvidia_gpu",
      requested_gpu_count: 1,
      visible_device_ids: []
    });
    const evidenceReceipt = JSON.parse(
      await readFile(
        path.join(runDir, "evidence_adequacy_execution_receipt.json"),
        "utf8"
      )
    );
    const evidenceAssessment = JSON.parse(
      await readFile(
        path.join(runDir, "evidence_adequacy_assessment.json"),
        "utf8"
      )
    );
    expect(evidenceReceipt).toMatchObject({
      kind: "evidence_adequacy_execution_receipt",
      primary_comparison_id: "comparison-primary-reference"
    });
    expect(evidenceAssessment).toMatchObject({
      kind: "evidence_adequacy_assessment",
      overall_status: "pass",
      passed: true
    });
  });

  it("rejects a runner-authored evidence verdict instead of issuing a receipt", async () => {
    const runId = "run-topic-forged-evidence-verdict";
    const { result, runDir } = await executeMeaningPreservationFixture({
      runId,
      briefRaw: TOPIC_DISCOVERY_COMPUTE_BRIEF,
      activeTopicProbeContract: buildTopicProbeExecutionContract(runId),
      comparisonContract: buildTopicProbeComparisonContract(runId),
      metrics: {
        status: "completed",
        success: true,
        quality_index: 0.7,
        ...buildExplicitResultsV2Fixture({
          metricId: "quality_index",
          primaryValue: 0.7,
          referenceValue: 0.4,
          comparisonDelta: 0.3
        }),
        compute_usage: {
          schema_version: 1,
          execution_kind: "gpu_execution",
          actual_gpu_count: 1,
          fresh_executed_trials: 1,
          cached_trials: 0
        },
        [EVIDENCE_ADEQUACY_METRICS_FIELD]: {
          passed: true
        }
      }
    });

    expect(result.status).toBe("failure");
    expect(result.error).toContain(
      "evidence_adequacy_execution_evidence_schema_invalid"
    );
    await expect(
      readFile(
        path.join(runDir, "evidence_adequacy_execution_receipt.json"),
        "utf8"
      )
    ).rejects.toThrow();
  });

  it("fails before ACI when topic discovery reaches execution without active probe lineage", async () => {
    const { result, runCommandCalls, runTestCalls } =
      await executeMeaningPreservationFixture({
        runId: "run-topic-lineage-missing",
        briefRaw: TOPIC_DISCOVERY_COMPUTE_BRIEF,
        metrics: {}
      });

    expect(result.status).toBe("failure");
    expect(result.error).toContain(
      "topic_discovery_active_bounded_probe_lineage_missing"
    );
    expect(runCommandCalls).toHaveLength(0);
    expect(runTestCalls).toHaveLength(0);
  });

  it("blocks a topic-probe pre-execution test command before any ACI call", async () => {
    const runId = "run-topic-pre-execution-command-blocked";
    const { result, runCommandCalls, runTestCalls } =
      await executeMeaningPreservationFixture({
        runId,
        briefRaw: TOPIC_DISCOVERY_COMPUTE_BRIEF,
        activeTopicProbeContract: buildTopicProbeExecutionContract(runId),
        comparisonContract: buildTopicProbeComparisonContract(runId),
        testCommand: "python3 -m py_compile run_configured_experiment.py",
        metrics: {}
      });

    expect(result.status).toBe("failure");
    expect(result.error).toContain(
      "topic_probe_pre_execution_test_command_forbidden"
    );
    expect(runCommandCalls).toHaveLength(0);
    expect(runTestCalls).toHaveLength(0);
  });

  it("fails before ACI when the requested GPU count is not explicitly declared", async () => {
    const runId = "run-topic-gpu-request-missing";
    const { result, runCommandCalls, runTestCalls } =
      await executeMeaningPreservationFixture({
        runId,
        briefRaw: TOPIC_DISCOVERY_COMPUTE_BRIEF,
        activeTopicProbeContract: buildTopicProbeExecutionContract(runId),
        comparisonContract: buildTopicProbeComparisonContract(runId),
        requestedGpuCount: null,
        metrics: {}
      });

    expect(result.status).toBe("failure");
    expect(result.error).toContain(
      "topic_probe_compute_preflight_requested_gpu_count_missing"
    );
    expect(runCommandCalls).toHaveLength(0);
    expect(runTestCalls).toHaveLength(0);
  });

  it("fails before ACI when the active contract ceiling differs from the raw brief", async () => {
    const runId = "run-topic-brief-ceiling-mismatch";
    const { result, runCommandCalls, runTestCalls } =
      await executeMeaningPreservationFixture({
        runId,
        briefRaw: TOPIC_DISCOVERY_COMPUTE_BRIEF.replace(
          '"max_gpu_hours":2',
          '"max_gpu_hours":3'
        ),
        activeTopicProbeContract: buildTopicProbeExecutionContract(runId),
        comparisonContract: buildTopicProbeComparisonContract(runId),
        metrics: {}
      });

    expect(result.status).toBe("failure");
    expect(result.error).toContain(
      "topic_probe_compute_active_contract_brief_ceiling_mismatch"
    );
    expect(runCommandCalls).toHaveLength(0);
    expect(runTestCalls).toHaveLength(0);
  });

  it("rejects a requested GPU count above the active cap without calling ACI", async () => {
    const runId = "run-topic-gpu-cap-exceeded";
    const { result, runDir, runCommandCalls, runTestCalls } =
      await executeMeaningPreservationFixture({
        runId,
        briefRaw: TOPIC_DISCOVERY_COMPUTE_BRIEF,
        activeTopicProbeContract: buildTopicProbeExecutionContract(runId),
        comparisonContract: buildTopicProbeComparisonContract(runId),
        requestedGpuCount: 2,
        metrics: {}
      });

    expect(result.status).toBe("failure");
    expect(result.error).toContain(
      "topic_probe_compute_preflight_max_concurrent_gpus_exceeded"
    );
    expect(runCommandCalls).toHaveLength(0);
    expect(runTestCalls).toHaveLength(0);
    const ledgerRaw = await readFile(
      path.join(
        runDir,
        "governance",
        "topic_probe_compute_usage_ledger.jsonl"
      ),
      "utf8"
    );
    expect(ledgerRaw).toContain('"decision":"rejected"');
  });

  it("applies a known local environment GPU limit before ACI", async () => {
    const runId = "run-topic-environment-gpu-limit";
    const { result, runCommandCalls, runTestCalls } =
      await executeMeaningPreservationFixture({
        runId,
        briefRaw: TOPIC_DISCOVERY_COMPUTE_BRIEF,
        activeTopicProbeContract: buildTopicProbeExecutionContract(runId),
        comparisonContract: buildTopicProbeComparisonContract(runId),
        requestedGpuCount: 1,
        environmentGpuAvailable: false,
        metrics: {}
      });

    expect(result.status).toBe("failure");
    expect(result.error).toContain(
      "topic_probe_compute_preflight_environment_gpu_limit_exceeded"
    );
    expect(runCommandCalls).toHaveLength(0);
    expect(runTestCalls).toHaveLength(0);
  });

  it("fails closed when bounded execution omits actual compute usage evidence", async () => {
    const runId = "run-topic-compute-missing-usage";
    const { result, runDir } = await executeMeaningPreservationFixture({
      runId,
      briefRaw: TOPIC_DISCOVERY_COMPUTE_BRIEF,
      activeTopicProbeContract: buildTopicProbeExecutionContract(runId),
      comparisonContract: buildTopicProbeComparisonContract(runId),
      metrics: {
        status: "completed",
        success: true,
        quality_index: 0.7,
        ...buildExplicitResultsV2Fixture({
          metricId: "quality_index",
          primaryValue: 0.7
        })
      }
    });

    expect(result.status).toBe("failure");
    expect(result.error).toContain(
      "topic_probe_compute_usage_evidence_schema_invalid"
    );
    const ledgerRaw = await readFile(
      path.join(
        runDir,
        "governance",
        "topic_probe_compute_usage_ledger.jsonl"
      ),
      "utf8"
    );
    expect(ledgerRaw).toContain('"event_kind":"usage_unverifiable"');
  });
});
