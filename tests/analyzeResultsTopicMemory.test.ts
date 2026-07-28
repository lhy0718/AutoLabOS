import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const topicProbeMocks = vi.hoisted(() => ({
  source: undefined as any,
  decision: undefined as any
}));

vi.mock("../src/core/topicProbeOutcomeArtifacts.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/core/topicProbeOutcomeArtifacts.js")
  >();
  return {
    ...actual,
    loadTopicProbeOutcomeArtifacts: (
      ...args: Parameters<typeof actual.loadTopicProbeOutcomeArtifacts>
    ) =>
      topicProbeMocks.source === undefined
        ? actual.loadTopicProbeOutcomeArtifacts(...args)
        : Promise.resolve(topicProbeMocks.source)
  };
});

vi.mock("../src/core/topicProbeOutcome.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/core/topicProbeOutcome.js")
  >();
  return {
    ...actual,
    buildTopicProbeOutcomeDecision: (
      ...args: Parameters<typeof actual.buildTopicProbeOutcomeDecision>
    ) =>
      topicProbeMocks.decision === undefined
        ? actual.buildTopicProbeOutcomeDecision(...args)
        : topicProbeMocks.decision
  };
});

import {
  buildActiveTopicProbeContract,
  type ActiveTopicProbeContract
} from "../src/core/activeTopicProbeContract.js";
import type { HypothesisEvidenceSeed } from "../src/core/analysis/researchPlanning.js";
import type { ResultsArtifactV2 } from "../src/core/analysis/resultsTableSchema.js";
import { InMemoryEventStream } from "../src/core/events.js";
import { MockLLMClient } from "../src/core/llm/client.js";
import { createAnalyzeResultsNode } from "../src/core/nodes/analyzeResults.js";
import { hashCanonical } from "../src/core/researchFunnel.js";
import {
  buildTopicMemoryDatabasePath,
  TopicMemoryStore
} from "../src/core/runs/topicMemoryStore.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import type { TopicProbeOutcomeDecision } from "../src/core/topicProbeOutcome.js";
import type { RunRecord } from "../src/types.js";
import {
  buildTopicProbePortfolioFixture,
  TOPIC_PROBE_FIXTURE_CANDIDATE_IDS
} from "./support/topicProbePortfolioFixture.js";

const temporaryDirectories: string[] = [];
const originalCwd = process.cwd();
let fixtureCounter = 0;

afterEach(() => {
  vi.restoreAllMocks();
  topicProbeMocks.source = undefined;
  topicProbeMocks.decision = undefined;
  process.chdir(originalCwd);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("analyze_results bounded-probe rejection topic memory", () => {
  it("fails without advancing when the durable append fails", async () => {
    const fixture = prepareFixture();
    vi.spyOn(TopicMemoryStore.prototype, "appendIdempotent").mockImplementation(
      () => {
        throw new Error("simulated_durable_append_failure");
      }
    );

    const result = await fixture.node.execute({
      run: fixture.run,
      graph: fixture.run.graph
    });
    const gate = readJson(
      path.join(fixture.runDir, "analysis", "topic_probe_outcome_gate.json")
    );
    const transition = readJson(
      path.join(fixture.runDir, "transition_recommendation.json")
    );

    expect(result).toMatchObject({
      status: "failure",
      failureKind: "environment",
      transitionRecommendation: {
        action: "retry_same",
        targetNode: "analyze_results",
        autoExecutable: false
      }
    });
    expect(result.transitionRecommendation?.targetNode).not.toBe("figure_audit");
    expect(gate).toMatchObject({
      status: "blocked_invalid_artifact_chain",
      disposition: null,
      outcome_content_sha256: null
    });
    expect(gate.reason_codes).toContain(
      "topic_memory_reject_persist_failed:simulated_durable_append_failure"
    );
    expect(transition.targetNode).toBe("analyze_results");
    expect(
      existsSync(path.join(fixture.runDir, "analysis", "topic_memory_update.json"))
    ).toBe(false);
  });

  it("gate-blocks a rejection that lacks two independently grounded evidence IDs", async () => {
    const fixture = prepareFixture({
      evidence: (rows) => rows.slice(0, 1)
    });

    const result = await fixture.node.execute({
      run: fixture.run,
      graph: fixture.run.graph
    });
    const transition = readJson(
      path.join(fixture.runDir, "transition_recommendation.json")
    );

    expect(result).toMatchObject({
      status: "failure",
      failureKind: "gate_blocked",
      transitionRecommendation: {
        action: "pause_for_human",
        autoExecutable: false
      }
    });
    expect(result.transitionRecommendation?.targetNode).toBeUndefined();
    expect(result.error).toContain(
      "topic_memory_reject_persist_failed:topic_memory_reject_evidence_id_unresolved"
    );
    expect(transition.action).toBe("pause_for_human");
    expect(
      existsSync(path.join(fixture.runDir, "analysis", "topic_memory_update.json"))
    ).toBe(false);
  });

  it("persists actual evidence IDs once and replays the same rejection idempotently", async () => {
    const fixture = prepareFixture();

    const first = await fixture.node.execute({
      run: fixture.run,
      graph: fixture.run.graph
    });
    const firstUpdate = readJson(
      path.join(fixture.runDir, "analysis", "topic_memory_update.json")
    );

    expect(first.status).toBe("success");
    expect(first.transitionRecommendation?.targetNode).toBe("figure_audit");
    expect(firstUpdate.status).toBe("appended");
    expect(firstUpdate.source_full_text_evidence_ids).toEqual(
      fixture.evidence.map((row) => row.evidence_id)
    );
    expect(firstUpdate.source_full_text_evidence_ids).not.toEqual(
      fixture.evidence.map((row) => row.paper_id)
    );

    const second = await fixture.node.execute({
      run: fixture.run,
      graph: fixture.run.graph
    });
    const secondUpdate = readJson(
      path.join(fixture.runDir, "analysis", "topic_memory_update.json")
    );
    const store = new TopicMemoryStore(
      buildTopicMemoryDatabasePath(fixture.workspaceRoot)
    );
    try {
      const ledger = store.loadLedger();
      expect(ledger.records).toHaveLength(1);
      expect(ledger.records[0].source_full_text_evidence_ids).toEqual(
        fixture.evidence.map((row) => row.evidence_id)
      );
    } finally {
      store.close();
    }

    expect(second.status).toBe("success");
    expect(secondUpdate.status).toBe("already_present");
    expect(secondUpdate.record_sha256).toBe(firstUpdate.record_sha256);
  });
});

function prepareFixture(options: {
  evidence?: (rows: HypothesisEvidenceSeed[]) => HypothesisEvidenceSeed[];
} = {}) {
  const workspaceRoot = mkdtempSync(
    path.join(os.tmpdir(), "autolabos-analyze-topic-memory-")
  );
  temporaryDirectories.push(workspaceRoot);
  process.chdir(workspaceRoot);
  fixtureCounter += 1;
  const runId = `run_analyze_topic_memory_${fixtureCounter}`;
  const researchCycle = 1;
  const runDir = path.join(workspaceRoot, ".autolabos", "runs", runId);
  mkdirSync(path.join(runDir, "memory"), { recursive: true });

  const portfolioFixture = buildTopicProbePortfolioFixture({
    runId,
    researchCycle,
    probeCandidateIds: [TOPIC_PROBE_FIXTURE_CANDIDATE_IDS[0]]
  });
  const activeCandidate = portfolioFixture.portfolio.candidates.find(
    (candidate) =>
      candidate.source_candidate_id === TOPIC_PROBE_FIXTURE_CANDIDATE_IDS[0]
  );
  if (!activeCandidate) {
    throw new Error("active candidate fixture missing");
  }
  const contract = buildActiveTopicProbeContract({
    runId,
    researchCycle,
    researchMode: "topic_discovery",
    portfolioContentSha256: portfolioFixture.portfolio.content_sha256,
    candidate: activeCandidate,
    deferredCandidateIds: [],
    generatedAt: "2026-01-01T00:00:00.000Z"
  });
  const decision = buildRejectDecision(contract);
  topicProbeMocks.source = {
    measured: true,
    valid: true,
    reasons: [],
    portfolio: portfolioFixture.portfolio,
    contract,
    decision
  };
  topicProbeMocks.decision = decision;

  const evidence = options.evidence
    ? options.evidence(portfolioFixture.evidence)
    : portfolioFixture.evidence;
  writeFileSync(
    path.join(runDir, "evidence_store.jsonl"),
    evidence.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8"
  );
  writeFileSync(
    path.join(runDir, "metrics.json"),
    JSON.stringify({
      outcome_measure: 0.4,
      results_artifact: buildResultsArtifact()
    }, null, 2),
    "utf8"
  );
  writeFileSync(
    path.join(runDir, "experiment_contract.json"),
    JSON.stringify(buildHistoricalExperimentContract(runId), null, 2),
    "utf8"
  );
  writeFileSync(
    path.join(runDir, "memory", "run_context.json"),
    JSON.stringify({
      version: 1,
      items: [{
        key: "run_brief.raw",
        value: "# Research Brief\n\n## Research Mode\n\ntopic_discovery\n",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }]
    }),
    "utf8"
  );

  const graph = createDefaultGraphState();
  graph.currentNode = "analyze_results";
  graph.researchCycle = researchCycle;
  const run: RunRecord = {
    version: 3,
    workflowVersion: 3,
    id: runId,
    title: "Bounded topic probe",
    topic: "Generic intervention evaluation",
    constraints: [],
    objectiveMetric: "outcome_measure >= 0.5",
    status: "running",
    currentNode: "analyze_results",
    nodeThreads: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    graph,
    memoryRefs: {
      runContextPath: `.autolabos/runs/${runId}/memory/run_context.json`,
      longTermPath: `.autolabos/runs/${runId}/memory/long_term.jsonl`,
      episodePath: `.autolabos/runs/${runId}/memory/episodes.jsonl`
    }
  };
  const node = createAnalyzeResultsNode({
    config: {} as never,
    runStore: {} as never,
    eventStream: new InMemoryEventStream(),
    llm: new MockLLMClient(),
    codex: {} as never,
    aci: {} as never,
    semanticScholar: {} as never
  });

  return {
    workspaceRoot,
    runDir,
    run,
    node,
    evidence: portfolioFixture.evidence
  };
}

function buildRejectDecision(
  contract: ActiveTopicProbeContract
): TopicProbeOutcomeDecision {
  const payload: Omit<TopicProbeOutcomeDecision, "content_sha256"> = {
    schema_version: 1,
    artifact_kind: "topic_probe_outcome_decision",
    run_id: contract.run_id,
    research_cycle: contract.research_cycle,
    candidate_id: contract.candidate_id,
    topic_id: contract.topic_id,
    contract_content_sha256: contract.content_sha256,
    primary_comparison_id: null,
    primary_metric: contract.primary_metric,
    observed_delta: 0.01,
    directed_delta: 0.01,
    required_magnitude: contract.effect_criterion.magnitude,
    evidence_adequacy_contract_sha256: null,
    evidence_adequacy_assessment_sha256: null,
    evidence_adequacy_status: "legacy_compatibility",
    executed_trials: 1,
    cached_trials: 0,
    primary_metric_ci_present: false,
    primary_effect_ci_directed_bound: null,
    primary_effect_ci_criterion_met: false,
    disposition: "reject_candidate",
    reason_codes: ["effect_floor_not_met"],
    evidence_refs: ["result_analysis.json#/results_artifact"],
    next_action: "refresh_topic_portfolio"
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

function buildHistoricalExperimentContract(runId: string) {
  return {
    version: 1,
    run_id: runId,
    created_at: "2026-01-01T00:00:00.000Z",
    hypothesis: "A declared intervention changes the outcome measure.",
    causal_mechanism: "The intervention changes the measured process.",
    single_change: "Apply the declared intervention.",
    confounded: false,
    expected_metric_effect: "Increase outcome_measure.",
    abort_condition: "Stop on invalid measurements.",
    keep_or_discard_rule: "Keep only with explicit comparative evidence.",
    baselines: ["declared_reference"],
    metrics: ["outcome_measure"],
    results_table_schema: [{
      metric: "outcome_measure",
      baseline: null,
      comparator: null,
      delta: null,
      direction: "higher_better"
    }]
  };
}

function buildResultsArtifact(): ResultsArtifactV2 {
  return {
    schema_version: "2.0",
    metrics: [{
      id: "outcome_measure",
      label: "Outcome measure",
      direction: "higher_better",
      unit: "unitless"
    }],
    series: [
      {
        id: "reference_series",
        label: "Reference series",
        role: "baseline",
        dimensions: { protocol: "reference" }
      },
      {
        id: "candidate_series",
        label: "Candidate series",
        role: "primary",
        dimensions: { protocol: "candidate" }
      }
    ],
    observations: [
      {
        id: "reference_observation",
        series_id: "reference_series",
        metric_id: "outcome_measure",
        scope: { partition: "validation" },
        value: 0.5
      },
      {
        id: "candidate_observation",
        series_id: "candidate_series",
        metric_id: "outcome_measure",
        scope: { partition: "validation" },
        value: 0.4
      }
    ],
    comparisons: [{
      id: "candidate-vs-reference",
      subject_observation_id: "candidate_observation",
      reference_observation_id: "reference_observation",
      delta: -0.1,
      hypothesis_supported: false
    }]
  };
}

function readJson(filePath: string): Record<string, any> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, any>;
}
