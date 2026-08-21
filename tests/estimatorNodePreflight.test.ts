import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ImplementSessionManager } from "../src/core/agents/implementSessionManager.js";
import { createImplementExperimentsNode } from "../src/core/nodes/implementExperiments.js";
import { createRunExperimentsNode } from "../src/core/nodes/runExperiments.js";
import { RunContextMemory } from "../src/core/memory/runContextMemory.js";
import { InMemoryEventStream } from "../src/core/events.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import {
  ACTIVE_TOPIC_PROBE_CONTRACT_RELATIVE_PATH,
  TOPIC_PROBE_DECISION_RELATIVE_PATH,
  TOPIC_PROBE_PORTFOLIO_RELATIVE_PATH
} from "../src/core/topicProbeOutcomeArtifacts.js";
import { buildActiveTopicProbeContract } from "../src/core/activeTopicProbeContract.js";
import {
  buildTopicDecision,
  validateTopicPortfolioArtifact
} from "../src/core/researchFunnel.js";
import { buildTopicProbePortfolioFixture } from "./support/topicProbePortfolioFixture.js";
import type { RunRecord } from "../src/types.js";

const ORIGINAL_CWD = process.cwd();

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
});

describe("topic-probe execution authorization preflight", () => {
  it("blocks implement_experiments before environment, model, or ACI calls", async () => {
    const fixture = await prepareIncompleteTopicDiscoveryRun(
      "run_estimator_implement_preflight",
      "implement_experiments"
    );
    const collectEnvironmentSnapshot = vi.fn();
    const codexRun = vi.fn();
    const llmComplete = vi.fn();
    const aci = aciSpies();
    const node = createImplementExperimentsNode(
      nodeDeps({ codexRun, llmComplete, aci }),
      { collectEnvironmentSnapshot }
    );

    const result = await node.execute({ run: fixture.run, graph: fixture.run.graph });

    expect(result).toMatchObject({
      status: "failure",
      failureKind: "gate_blocked",
      toolCallsUsed: 0
    });
    expect(result.error).toContain("topic_probe_execution_preflight_blocked");
    expect(collectEnvironmentSnapshot).not.toHaveBeenCalled();
    expect(codexRun).not.toHaveBeenCalled();
    expect(llmComplete).not.toHaveBeenCalled();
    expectNoAciCalls(aci);
  });

  it("blocks direct ImplementSessionManager use before model or ACI calls", async () => {
    const fixture = await prepareIncompleteTopicDiscoveryRun(
      "run_estimator_manager_preflight",
      "implement_experiments"
    );
    const codexRun = vi.fn();
    const llmComplete = vi.fn();
    const aci = aciSpies();
    const manager = new ImplementSessionManager({
      config: {} as any,
      codex: { runTurnStream: codexRun } as any,
      llm: { complete: llmComplete } as any,
      aci: aci as any,
      eventStream: new InMemoryEventStream(),
      runStore: {} as any,
      workspaceRoot: fixture.root
    });

    await expect(manager.run(fixture.run)).rejects.toMatchObject({
      name: "ImplementSessionStopError",
      failureKind: "gate_blocked",
      toolCallsUsed: 0
    });
    expect(codexRun).not.toHaveBeenCalled();
    expect(llmComplete).not.toHaveBeenCalled();
    expectNoAciCalls(aci);
  });

  it("blocks run_experiments on a missing evidence contract before tests, experiment commands, or LLM calls", async () => {
    const fixture = await prepareIncompleteTopicDiscoveryRun(
      "run_estimator_execution_preflight",
      "run_experiments"
    );
    const codexRun = vi.fn();
    const llmComplete = vi.fn();
    const aci = aciSpies();
    const node = createRunExperimentsNode(
      nodeDeps({ codexRun, llmComplete, aci })
    );

    const result = await node.execute({ run: fixture.run, graph: fixture.run.graph });

    expect(result).toMatchObject({
      status: "failure",
      failureKind: "gate_blocked",
      toolCallsUsed: 0
    });
    expect(result.error).toContain("topic_probe_evidence_adequacy_contract_missing");
    expect(codexRun).not.toHaveBeenCalled();
    expect(llmComplete).not.toHaveBeenCalled();
    expectNoAciCalls(aci);
  });
});

async function prepareIncompleteTopicDiscoveryRun(
  runId: string,
  node: "implement_experiments" | "run_experiments"
): Promise<{ root: string; run: RunRecord }> {
  const root = await mkdtemp(path.join(tmpdir(), "autolabos-estimator-node-"));
  process.chdir(root);
  const graph = createDefaultGraphState();
  graph.currentNode = node;
  graph.researchCycle = 1;
  const run: RunRecord = {
    version: 3,
    workflowVersion: 3,
    id: runId,
    title: "Governed comparison",
    topic: "A bounded comparison under a declared protocol",
    constraints: [],
    objectiveMetric: "primary_effect >= 0 proportion",
    status: "running",
    currentNode: node,
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
  const runDir = path.join(root, ".autolabos", "runs", run.id);
  await mkdir(path.join(runDir, "memory"), { recursive: true });
  const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
  await runContext.put(
    "run_brief.raw",
    "# Research Brief\n\n## Research Mode\ntopic_discovery\n"
  );
  const portfolioFixture = buildTopicProbePortfolioFixture({
    runId,
    researchCycle: graph.researchCycle
  });
  const portfolioValidation = validateTopicPortfolioArtifact(
    JSON.stringify(portfolioFixture.portfolio),
    {
      expectedRunId: runId,
      expectedResearchCycle: graph.researchCycle
    }
  );
  if (!portfolioValidation.valid) {
    throw new Error(
      `estimator_preflight_portfolio_fixture_invalid:${portfolioValidation.reasons.join(",")}`
    );
  }
  const decision = buildTopicDecision({
    runId,
    researchCycle: graph.researchCycle,
    generatedAt: "2026-01-01T00:00:00.000Z",
    validation: portfolioValidation
  });
  const activeProbe = buildActiveTopicProbeContract({
    runId,
    researchCycle: graph.researchCycle,
    researchMode: "topic_discovery",
    portfolioContentSha256: portfolioFixture.portfolio.content_sha256,
    candidate: portfolioFixture.portfolio.candidates[0]!
  });
  await Promise.all([
    writeJsonArtifact(runDir, TOPIC_PROBE_PORTFOLIO_RELATIVE_PATH, portfolioFixture.portfolio),
    writeJsonArtifact(runDir, TOPIC_PROBE_DECISION_RELATIVE_PATH, decision),
    writeJsonArtifact(runDir, ACTIVE_TOPIC_PROBE_CONTRACT_RELATIVE_PATH, activeProbe)
  ]);
  return { root, run };
}

async function writeJsonArtifact(
  runDir: string,
  relativePath: string,
  value: unknown
): Promise<void> {
  const artifactPath = path.join(runDir, relativePath);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(
    artifactPath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8"
  );
}

function nodeDeps(input: {
  codexRun: ReturnType<typeof vi.fn>;
  llmComplete: ReturnType<typeof vi.fn>;
  aci: ReturnType<typeof aciSpies>;
}) {
  const llm = { complete: input.llmComplete } as any;
  return {
    config: { experiments: { runner: "local_python", timeout_sec: 60 } } as any,
    executionProfile: "local" as const,
    runStore: {} as any,
    eventStream: new InMemoryEventStream(),
    llm,
    experimentLlm: llm,
    pdfTextLlm: llm,
    codex: { runTurnStream: input.codexRun } as any,
    aci: input.aci as any,
    semanticScholar: {} as any,
    openAlex: {} as any,
    crossref: {} as any,
    arxiv: {} as any,
    responsesPdfAnalysis: {} as any
  };
}

function aciSpies() {
  return {
    searchCode: vi.fn(),
    findSymbol: vi.fn(),
    listFiles: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    applyPatch: vi.fn(),
    runTests: vi.fn(),
    runCommand: vi.fn()
  };
}

function expectNoAciCalls(aci: ReturnType<typeof aciSpies>): void {
  for (const spy of Object.values(aci)) {
    expect(spy).not.toHaveBeenCalled();
  }
}
