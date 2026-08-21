import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, readFile, unlink, writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  buildEstimatorFeasibilityArtifacts,
  ESTIMATOR_FEASIBILITY_CANDIDATE_EXPERIMENT_CONTRACT_RELATIVE_PATH,
  ESTIMATOR_FEASIBILITY_CONTRACT_RELATIVE_PATH,
  ESTIMATOR_FEASIBILITY_REPORT_RELATIVE_PATH,
  loadPersistedEstimatorFeasibilityAudit,
  validatePersistedEstimatorFeasibilityGate
} from "../src/core/estimatorFeasibilityGate.js";
import { buildActiveTopicProbeContract } from "../src/core/activeTopicProbeContract.js";
import { ACTIVE_TOPIC_PROBE_CONTRACT_RELATIVE_PATH } from "../src/core/topicProbeOutcomeArtifacts.js";
import { buildExperimentContract } from "../src/core/experiments/experimentContract.js";
import type { EstimatorProtocolDeclaration } from "../src/core/estimatorProtocol.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import type { RunRecord } from "../src/types.js";
import { buildTopicProbePortfolioFixture } from "./support/topicProbePortfolioFixture.js";

describe("persisted estimator feasibility gate", () => {
  it("passes only when all four artifacts remain hash-bound to the current run", async () => {
    const fixture = await writeGateFixture("run_estimator_gate_pass");

    const gate = await validatePersistedEstimatorFeasibilityGate({
      workspaceRoot: fixture.root,
      runId: fixture.run.id,
      expectedResearchCycle: fixture.run.graph.researchCycle
    });

    expect(gate).toMatchObject({
      measured: true,
      valid: true,
      status: "pass",
      reasons: [],
      estimator_report: { status: "pass" }
    });
  });

  it("fails closed when required artifacts are absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-estimator-gate-"));
    const gate = await validatePersistedEstimatorFeasibilityGate({
      workspaceRoot: root,
      runId: "run_estimator_gate_missing",
      expectedResearchCycle: 1
    });

    expect(gate).toMatchObject({ measured: false, valid: false, status: "blocked" });
    expect(gate.reasons).toEqual(expect.arrayContaining([
      "estimator_gate_active_probe_missing",
      "estimator_gate_experiment_contract_missing",
      "estimator_gate_contract_missing",
      "estimator_gate_report_missing"
    ]));
  });

  it("detects experiment-contract drift after the estimator report was frozen", async () => {
    const fixture = await writeGateFixture("run_estimator_gate_drift");
    const experimentPath = path.join(fixture.runDir, "experiment_contract.json");
    const experiment = JSON.parse(await readFile(experimentPath, "utf8")) as Record<string, unknown>;
    experiment.expected_metric_effect = "A different effect declaration.";
    await writeFile(experimentPath, `${JSON.stringify(experiment, null, 2)}\n`, "utf8");

    const gate = await validatePersistedEstimatorFeasibilityGate({
      workspaceRoot: fixture.root,
      runId: fixture.run.id,
      expectedResearchCycle: fixture.run.graph.researchCycle
    });

    expect(gate.valid).toBe(false);
    expect(gate.reasons).toEqual(expect.arrayContaining([
      "estimator_gate_contract_invalid:experiment_binding_mismatch",
      "estimator_gate_report_invalid:report_recomputed_mismatch"
    ]));
  });

  it("preserves a reproducible blocked report as a hard gate", async () => {
    const protocol = pairedProtocol();
    protocol.pairing.independent_clusters = 12;
    protocol.outcome.attainable_resolution = 1 / 12;
    protocol.power.assumed_standard_deviation = 0.05;
    const fixture = await writeGateFixture(
      "run_estimator_gate_blocked",
      protocol
    );

    const gate = await validatePersistedEstimatorFeasibilityGate({
      workspaceRoot: fixture.root,
      runId: fixture.run.id,
      expectedResearchCycle: fixture.run.graph.researchCycle
    });

    expect(gate).toMatchObject({ valid: false, status: "blocked" });
    expect(gate.reasons).toContain(
      "estimator_gate_feasibility_blocked:too_few_clusters"
    );
  });

  it("trusts a reproducible blocked candidate decision without authorizing execution", async () => {
    const protocol = pairedProtocol();
    protocol.pairing.independent_clusters = 12;
    protocol.outcome.attainable_resolution = 1 / 12;
    protocol.power.assumed_standard_deviation = 0.05;
    const fixture = await writeGateFixture(
      "run_estimator_audit_blocked_candidate",
      protocol
    );
    const executablePath = path.join(fixture.runDir, "experiment_contract.json");
    const candidatePath = path.join(
      fixture.runDir,
      ESTIMATOR_FEASIBILITY_CANDIDATE_EXPERIMENT_CONTRACT_RELATIVE_PATH
    );
    await mkdir(path.dirname(candidatePath), { recursive: true });
    await writeFile(candidatePath, await readFile(executablePath, "utf8"), "utf8");
    await unlink(executablePath);

    const audit = await loadPersistedEstimatorFeasibilityAudit({
      runDir: fixture.runDir,
      runId: fixture.run.id,
      expectedResearchCycle: fixture.run.graph.researchCycle
    });

    expect(audit).toMatchObject({
      measured: true,
      trusted: true,
      status: "blocked",
      execution_authorized: false
    });
    expect(audit.reason_codes).toContain("too_few_clusters");
  });

  it("rejects a candidate contract that differs from the promoted executable contract", async () => {
    const fixture = await writeGateFixture("run_estimator_audit_promotion_drift");
    const executablePath = path.join(fixture.runDir, "experiment_contract.json");
    const candidate = JSON.parse(await readFile(executablePath, "utf8")) as Record<string, unknown>;
    candidate.expected_metric_effect = "A conflicting candidate effect declaration.";
    const candidatePath = path.join(
      fixture.runDir,
      ESTIMATOR_FEASIBILITY_CANDIDATE_EXPERIMENT_CONTRACT_RELATIVE_PATH
    );
    await mkdir(path.dirname(candidatePath), { recursive: true });
    await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");

    const audit = await loadPersistedEstimatorFeasibilityAudit({
      runDir: fixture.runDir,
      runId: fixture.run.id,
      expectedResearchCycle: fixture.run.graph.researchCycle
    });

    expect(audit).toMatchObject({
      trusted: false,
      status: "invalid",
      execution_authorized: false
    });
    expect(audit.reason_codes).toContain(
      "estimator_audit_candidate_promotion_mismatch"
    );
  });
});

async function writeGateFixture(
  runId: string,
  protocol = pairedProtocol()
): Promise<{ root: string; runDir: string; run: RunRecord }> {
  const root = await mkdtemp(path.join(tmpdir(), "autolabos-estimator-gate-"));
  const run = makeRun(runId);
  const runDir = path.join(root, ".autolabos", "runs", run.id);
  const portfolioFixture = buildTopicProbePortfolioFixture({
    runId,
    researchCycle: run.graph.researchCycle
  });
  const candidate = portfolioFixture.portfolio.candidates[0]!;
  const activeProbe = buildActiveTopicProbeContract({
    runId,
    researchCycle: run.graph.researchCycle,
    researchMode: "topic_discovery",
    portfolioContentSha256: portfolioFixture.portfolio.content_sha256,
    candidate
  });
  const experimentContract = buildExperimentContract({
    run,
    hypothesis: "A declared intervention changes the primary outcome.",
    causalMechanism: "Only the declared intervention differs between arms.",
    singleChange: "Enable the declared intervention.",
    expectedMetricEffect: "The primary outcome differs from the reference.",
    abortCondition: "Abort when a declared analysis unit is missing.",
    keepOrDiscardRule: "Keep only complete matched comparisons.",
    baselines: ["reference"],
    resultsPlan: {
      schema_version: "2.0",
      required_metrics: [{
        id: "primary_effect",
        label: "Primary effect",
        direction: "higher_better",
        unit: "proportion"
      }],
      minimum_series_count: 2,
      minimum_comparison_count: 1,
      required_series: [
        { id: "reference", role: "baseline" },
        { id: "candidate", role: "primary" }
      ],
      required_comparisons: [{
        id: "primary_effect",
        subject_series_id: "candidate",
        reference_series_id: "reference",
        metric_id: "primary_effect",
        scope: { partition: "evaluation" }
      }],
      primary_comparison_id: "primary_effect"
    }
  });
  const estimatorArtifacts = buildEstimatorFeasibilityArtifacts({
    runId,
    activeProbeSha256: activeProbe.content_sha256,
    experimentContract,
    estimatorProtocol: protocol
  });
  const artifacts = [
    [ACTIVE_TOPIC_PROBE_CONTRACT_RELATIVE_PATH, activeProbe],
    ["experiment_contract.json", experimentContract],
    [ESTIMATOR_FEASIBILITY_CONTRACT_RELATIVE_PATH, estimatorArtifacts.contract],
    [ESTIMATOR_FEASIBILITY_REPORT_RELATIVE_PATH, estimatorArtifacts.report]
  ] as const;
  await Promise.all(artifacts.map(async ([relativePath, value]) => {
    const artifactPath = path.join(runDir, relativePath);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }));
  return { root, runDir, run };
}

function makeRun(id: string): RunRecord {
  const graph = createDefaultGraphState();
  graph.researchCycle = 1;
  return {
    version: 3,
    workflowVersion: 3,
    id,
    title: "Governed comparison",
    topic: "A bounded comparison under a declared protocol",
    constraints: [],
    objectiveMetric: "primary_effect >= 0 proportion",
    status: "running",
    currentNode: "design_experiments",
    nodeThreads: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    graph,
    memoryRefs: {
      runContextPath: `.autolabos/runs/${id}/memory/run_context.json`,
      longTermPath: `.autolabos/runs/${id}/memory/long_term.jsonl`,
      episodePath: `.autolabos/runs/${id}/memory/episodes.jsonl`
    }
  };
}

function pairedProtocol(): EstimatorProtocolDeclaration {
  return {
    schema_version: 1,
    units: {
      execution_unit: "condition execution",
      exposure_unit: "condition",
      outcome_unit: "response",
      analysis_unit: "matched comparison",
      independent_cluster_key: "comparison_id"
    },
    arms: ["reference", "candidate"],
    primary_contrast: ["candidate", "reference"],
    pairing: {
      mode: "paired",
      independent_clusters: 40,
      observations_per_arm_per_cluster: 1
    },
    outcome: { type: "binary", attainable_resolution: 0.025 },
    estimand: {
      id: "primary_effect",
      type: "paired_risk_difference",
      scale: "proportion"
    },
    estimator: {
      family: "paired_risk_difference",
      covariance: "cluster_bootstrap",
      separation_policy: "not_applicable"
    },
    power: {
      alpha: 0.05,
      target_power: 0.8,
      minimum_detectable_effect: 0.1,
      assumed_standard_deviation: 0.15,
      sidedness: "two_sided"
    },
    resampling: { minimum_clusters: 30, replicates: 2_000 },
    multiplicity: {
      primary_comparison_id: "primary_effect",
      family: ["primary_effect"],
      method: "none",
      family_alpha: 0.05
    }
  };
}
