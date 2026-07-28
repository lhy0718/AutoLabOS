import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDesignExperimentsNode,
  rebaseTopicPortfolioToCurrentMemory
} from "../src/core/nodes/designExperiments.js";
import {
  RESEARCH_FUNNEL_SOURCE_ARTIFACT_PATHS,
  buildResearchFunnelArtifactBinding,
  buildResearchGapMap,
  buildTopicDecision,
  buildTopicPortfolio,
  resolveSupportedGapIds,
  validateTopicPortfolioArtifact
} from "../src/core/researchFunnel.js";
import {
  buildActiveTopicProbeContract,
  validateActiveTopicProbeContract
} from "../src/core/activeTopicProbeContract.js";
import {
  buildTopicMemoryDatabasePath,
  TopicMemoryStore
} from "../src/core/runs/topicMemoryStore.js";
import type { TopicMemoryLedger } from "../src/core/topicMemory.js";
import { InMemoryEventStream } from "../src/core/events.js";
import { MockLLMClient } from "../src/core/llm/client.js";
import { RunContextMemory } from "../src/core/memory/runContextMemory.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import type { RunRecord } from "../src/types.js";
import {
  buildPassingPriorAbsorptionMatrixFixture
} from "./support/priorAbsorptionFixture.js";
import { buildTopicProbePortfolioFixture } from "./support/topicProbePortfolioFixture.js";
import { makeTopicProbeComputeBudgetLimits } from "./support/topicProbeComputeBudget.js";

vi.mock("../src/core/analysis/researchGapEvidenceChain.js", () => ({
  buildResearchGapEvidenceChain: () => ({
    validationContext: {},
    reasonCodes: []
  })
}));

const ORIGINAL_CWD = process.cwd();

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
});

function makeRun(runId: string): RunRecord {
  return {
    version: 3,
    workflowVersion: 3,
    id: runId,
    title: "Governed topic discovery",
    topic: "A bounded comparison under a declared evaluation scope",
    constraints: ["local execution", "open evidence"],
    objectiveMetric: "primary_measure >= 0 score_unit",
    status: "running",
    currentNode: "design_experiments",
    nodeThreads: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    graph: createDefaultGraphState(),
    memoryRefs: {
      runContextPath: `.autolabos/runs/${runId}/memory/run_context.json`,
      longTermPath: `.autolabos/runs/${runId}/memory/long_term.jsonl`,
      episodePath: `.autolabos/runs/${runId}/memory/episodes.jsonl`
    }
  };
}

async function seedTopicDiscoveryChain(
  root: string,
  run: RunRecord
): Promise<ReturnType<typeof buildTopicPortfolio>> {
  const runDir = path.join(root, ".autolabos", "runs", run.id);
  const generatedAt = "2026-01-01T00:00:00.000Z";
  const base = buildTopicProbePortfolioFixture({
    runId: run.id,
    researchCycle: run.graph.researchCycle,
    generatedAt
  });
  const gapMap = buildResearchGapMap({
    evidence: base.evidence,
    runId: run.id,
    researchCycle: run.graph.researchCycle,
    generatedAt
  });
  const reviews = base.candidates.map((candidate) => ({
    candidate_id: candidate.id,
    run_id: run.id,
    research_cycle: run.graph.researchCycle,
    keep: true,
    groundedness: 4,
    causal_clarity: 4,
    falsifiability: 4,
    experimentability: 4,
    measurement_specificity: 4,
    measurement_signals: ["repeated_run_variance"],
    measurement_hint:
      "Compare the primary measure with uncertainty across matched runs.",
    limitation_reflection: 4,
    measurement_readiness: 4,
    strengths: ["The comparison and falsifier are explicit."],
    weaknesses: ["The bounded scope requires later external validation."]
  }));
  const drafts = base.candidates.map((candidate) => ({
    ...candidate,
    run_id: run.id,
    research_cycle: run.graph.researchCycle,
    supported_gap_ids: resolveSupportedGapIds(
      candidate.evidence_links,
      gapMap
    )
  }));
  const evidenceAxes = [1, 2, 3].map((index) => ({
    id: `evaluation_axis_${index}`,
    label: `Evaluation axis ${index}`,
    mechanism: `Mechanism ${index} is grounded in the source evidence.`,
    intervention: `Intervention ${index} isolates a matched comparison.`,
    evidence_links: base.evidence.map((item) => item.evidence_id!)
  }));
  const hypotheses = drafts.map((candidate, index) => {
    const review = reviews[index]!;
    const { id, ...candidateContract } = candidate;
    return {
      ...candidateContract,
      hypothesis_id: `hypothesis_${index + 1}`,
      candidate_id: id,
      score: candidate.testability,
      groundedness: review.groundedness,
      causal_clarity: review.causal_clarity,
      falsifiability: review.falsifiability,
      experimentability: review.experimentability,
      measurement_specificity: review.measurement_specificity,
      limitation_reflection: review.limitation_reflection,
      measurement_readiness: review.measurement_readiness
    };
  });
  const priorAbsorptionMatrix = buildPassingPriorAbsorptionMatrixFixture({
    candidates: base.candidates,
    evidence: base.evidence,
    runId: run.id,
    researchCycle: run.graph.researchCycle,
    generatedAt
  });
  const preliminaryPortfolio = buildTopicPortfolio({
    candidates: base.candidates,
    reviews,
    probeCandidateIds: base.candidates.map((candidate) => candidate.id),
    evidence: base.evidence,
    evidenceAxes,
    gapMap,
    runId: run.id,
    researchCycle: run.graph.researchCycle,
    generatedAt,
    priorAbsorptionMatrix,
    computeBudgetCeiling: makeTopicProbeComputeBudgetLimits()
  });
  const shortlist = {
    run_id: run.id,
    research_cycle: run.graph.researchCycle,
    probe_candidate_ids: preliminaryPortfolio.probe_candidate_ids,
    probe_topic_ids: preliminaryPortfolio.probe_topic_ids,
    ranked_candidate_ids: base.candidates.map((candidate) => candidate.id),
    scores: base.candidates.map((candidate) => ({
      candidate_id: candidate.id
    }))
  };
  const serializeJsonl = (items: unknown[]) =>
    `${items.map((item) => JSON.stringify(item)).join("\n")}\n`;
  const sourceContents = {
    "analysis/gap_map.json": `${JSON.stringify(gapMap, null, 2)}\n`,
    "hypothesis_generation/evidence_axes.json":
      `${JSON.stringify(evidenceAxes, null, 2)}\n`,
    "hypothesis_generation/prior_absorption_matrix.json":
      `${JSON.stringify(priorAbsorptionMatrix, null, 2)}\n`,
    "hypotheses.jsonl": serializeJsonl(hypotheses),
    "hypothesis_generation/drafts.jsonl": serializeJsonl(drafts),
    "hypothesis_generation/reviews.jsonl": serializeJsonl(reviews),
    "hypothesis_generation/probe_shortlist.json":
      `${JSON.stringify(shortlist, null, 2)}\n`
  } as const;
  const portfolio = buildTopicPortfolio({
    candidates: base.candidates,
    reviews,
    probeCandidateIds: base.candidates.map((candidate) => candidate.id),
    evidence: base.evidence,
    evidenceAxes,
    gapMap,
    runId: run.id,
    researchCycle: run.graph.researchCycle,
    generatedAt,
    priorAbsorptionMatrix,
    computeBudgetCeiling: makeTopicProbeComputeBudgetLimits(),
    sourceArtifactBindings: RESEARCH_FUNNEL_SOURCE_ARTIFACT_PATHS.map(
      (artifactPath) => buildResearchFunnelArtifactBinding(
        artifactPath,
        sourceContents[artifactPath]
      )
    )
  });
  await mkdir(runDir, { recursive: true });
  await Promise.all([
    ...Object.entries(sourceContents).map(async ([relativePath, content]) => {
      const artifactPath = path.join(runDir, relativePath);
      await mkdir(path.dirname(artifactPath), { recursive: true });
      await writeFile(artifactPath, content, "utf8");
    }),
    (async () => {
      const artifactPath = path.join(
        runDir,
        "hypothesis_generation",
        "topic_portfolio.json"
      );
      await mkdir(path.dirname(artifactPath), { recursive: true });
      await writeFile(
        artifactPath,
        `${JSON.stringify(portfolio, null, 2)}\n`,
        "utf8"
      );
    })(),
    (async () => {
      await writeFile(
        path.join(runDir, "evidence_store.jsonl"),
        serializeJsonl(base.evidence),
        "utf8"
      );
      await writeFile(path.join(runDir, "corpus.jsonl"), "{}\n", "utf8");
      await writeFile(
        path.join(runDir, "collect_generation.json"),
        "{}\n",
        "utf8"
      );
      await mkdir(path.join(runDir, "analysis"), { recursive: true });
      await writeFile(
        path.join(runDir, "analysis", "gap_synthesis.json"),
        "{}\n",
        "utf8"
      );
    })()
  ]);
  const memory = new RunContextMemory(run.memoryRefs.runContextPath);
  await memory.put(
    "run_brief.raw",
    "# Research Brief\n\n## Research Mode\ntopic_discovery\n"
  );
  return portfolio;
}

describe("design_experiments topic-memory head binding", () => {
  it("loads the workspace head and preserves backtrack semantics for a post-portfolio kill", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "autolabos-design-node-memory-")
    );
    process.chdir(root);
    const run = makeRun("run_design_node_stale_topic_memory");
    const sourcePortfolio = await seedTopicDiscoveryChain(root, run);
    const candidate = sourcePortfolio.candidates[0];
    const descriptor = candidate?.topic_memory?.descriptor;
    if (!candidate || !descriptor) {
      throw new Error("topic_memory_node_test_candidate_missing");
    }
    const store = new TopicMemoryStore(
      buildTopicMemoryDatabasePath(root)
    );
    let currentLedger: TopicMemoryLedger;
    try {
      store.append({
        descriptor,
        kill_scope: "exact_formulation",
        disposition_category: "prior_work_absorbed",
        public_reason_codes: ["closest_prior_absorbs_contribution"],
        source_run_id: "run_independent_review",
        source_research_cycle: 1,
        source_full_text_evidence_ids: [
          "evidence_reference_1",
          "evidence_reference_2"
        ],
        source_topic_content_sha256: "c".repeat(64),
        source_decision_content_sha256: "d".repeat(64)
      });
      currentLedger = store.loadLedger();
    } finally {
      store.close();
    }

    const node = createDesignExperimentsNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new MockLLMClient(),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any
    });
    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, JSON.stringify(result)).toBe("success");
    expect(result.needsApproval).toBe(true);
    expect(result.transitionRecommendation).toMatchObject({
      action: "backtrack_to_hypotheses",
      sourceNode: "design_experiments",
      targetNode: "analyze_papers",
      autoExecutable: true
    });
    expect(result.transitionRecommendation?.suggestedCommands).toContain(
      `/agent run analyze_papers ${run.id}`
    );
    expect(result.summary).toContain(
      "topic_memory_clear_or_reentry_allowed"
    );
    const runDir = path.join(root, ".autolabos", "runs", run.id);
    const refreshedPortfolio = JSON.parse(
      await readFile(
        path.join(
          runDir,
          "hypothesis_generation",
          "topic_portfolio.json"
        ),
        "utf8"
      )
    ) as ReturnType<typeof buildTopicPortfolio>;
    expect(refreshedPortfolio.topic_memory_ledger?.ledger_sha256).toBe(
      currentLedger.ledger_sha256
    );
    expect(refreshedPortfolio.probe_allowed).toBe(false);
    const refresh = JSON.parse(
      await readFile(
        path.join(
          runDir,
          "design_experiments_panel",
          "topic_memory_refresh.json"
        ),
        "utf8"
      )
    ) as {
      snapshot_relation: string;
      current_ledger_sha256?: string;
      refreshed_portfolio_content_sha256?: string;
    };
    expect(refresh).toMatchObject({
      snapshot_relation: "ancestor",
      current_ledger_sha256: currentLedger.ledger_sha256,
      refreshed_portfolio_content_sha256:
        refreshedPortfolio.content_sha256
    });
    const decision = JSON.parse(
      await readFile(
        path.join(
          runDir,
          "design_experiments_panel",
          "topic_decision.json"
        ),
        "utf8"
      )
    ) as {
      disposition: string;
      portfolio_content_sha256?: string;
      reason_codes: string[];
    };
    expect(decision).toMatchObject({
      disposition: "backtrack_to_hypotheses",
      portfolio_content_sha256: refreshedPortfolio.content_sha256
    });
    expect(decision.reason_codes).toContain(
      "topic_memory_clear_or_reentry_allowed"
    );
    await expect(
      readFile(
        path.join(
          runDir,
          "design_experiments_panel",
          "active_topic_probe_contract.json"
        ),
        "utf8"
      )
    ).rejects.toThrow();
  });

  it("re-evaluates a legitimate stale prefix and backtracks when a new kill blocks a candidate", async () => {
    const runId = "run_design_stale_topic_memory";
    const researchCycle = 2;
    const fixture = buildTopicProbePortfolioFixture({
      runId,
      researchCycle
    });
    const candidate = fixture.portfolio.candidates[0];
    const descriptor = candidate?.topic_memory?.descriptor;
    expect(descriptor).toBeDefined();
    if (!candidate || !descriptor) {
      throw new Error("topic_memory_test_candidate_missing");
    }

    const root = await mkdtemp(path.join(tmpdir(), "autolabos-design-memory-"));
    const store = new TopicMemoryStore(path.join(root, "topic-memory.sqlite"));
    let currentLedger: TopicMemoryLedger;
    try {
      store.append({
        descriptor,
        kill_scope: "exact_formulation",
        disposition_category: "prior_work_absorbed",
        public_reason_codes: ["closest_prior_absorbs_contribution"],
        source_run_id: "run_independent_review",
        source_research_cycle: 1,
        source_full_text_evidence_ids: [
          "evidence_reference_1",
          "evidence_reference_2"
        ],
        source_topic_content_sha256: "a".repeat(64),
        source_decision_content_sha256: "b".repeat(64)
      });
      currentLedger = store.loadLedger();
    } finally {
      store.close();
    }

    const resolution = rebaseTopicPortfolioToCurrentMemory({
      portfolio: fixture.portfolio,
      currentLedger
    });

    expect(resolution.valid, resolution.reasons.join(", ")).toBe(true);
    expect(resolution.snapshot_relation).toBe("ancestor");
    expect(resolution.snapshot_ledger_sha256).toBe(
      fixture.portfolio.topic_memory_ledger?.ledger_sha256
    );
    expect(resolution.current_ledger_sha256).toBe(currentLedger.ledger_sha256);
    expect(resolution.current_ledger_sha256).not.toBe(
      resolution.snapshot_ledger_sha256
    );
    expect(resolution.portfolio?.topic_memory_ledger?.ledger_sha256).toBe(
      currentLedger.ledger_sha256
    );
    expect(resolution.portfolio?.probe_allowed).toBe(false);
    expect(
      resolution.candidate_decisions.find(
        (item) => item.candidate_id === candidate.source_candidate_id
      )?.decision
    ).toMatchObject({
      disposition: "blocked",
      blocked: true,
      exact_formulation_match: true,
      reason_codes: ["topic_memory_exact_formulation_killed"]
    });

    const portfolioValidation = validateTopicPortfolioArtifact(
      JSON.stringify(resolution.portfolio),
      { expectedRunId: runId, expectedResearchCycle: researchCycle }
    );
    expect(
      portfolioValidation.valid,
      portfolioValidation.reasons.join(", ")
    ).toBe(true);
    const decision = buildTopicDecision({
      runId,
      researchCycle,
      validation: portfolioValidation,
      generatedAt: "2026-01-02T00:00:00.000Z"
    });
    expect(decision).toMatchObject({
      disposition: "backtrack_to_hypotheses",
      probe_allowed: false,
      portfolio_content_sha256: resolution.portfolio?.content_sha256
    });
    expect(decision.reason_codes).toContain(
      "topic_memory_clear_or_reentry_allowed"
    );
  });

  it("keeps an authorized decision and active contract bound to the current ledger head", async () => {
    const runId = "run_design_current_topic_memory";
    const researchCycle = 3;
    const fixture = buildTopicProbePortfolioFixture({
      runId,
      researchCycle
    });
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-design-memory-"));
    const store = new TopicMemoryStore(path.join(root, "topic-memory.sqlite"));
    let currentLedger: TopicMemoryLedger;
    try {
      currentLedger = store.loadLedger();
    } finally {
      store.close();
    }

    const resolution = rebaseTopicPortfolioToCurrentMemory({
      portfolio: fixture.portfolio,
      currentLedger
    });
    expect(resolution.valid, resolution.reasons.join(", ")).toBe(true);
    expect(resolution.snapshot_relation).toBe("current");
    expect(resolution.portfolio?.topic_memory_ledger?.ledger_sha256).toBe(
      currentLedger.ledger_sha256
    );

    const portfolioValidation = validateTopicPortfolioArtifact(
      JSON.stringify(resolution.portfolio),
      { expectedRunId: runId, expectedResearchCycle: researchCycle }
    );
    expect(
      portfolioValidation.valid,
      portfolioValidation.reasons.join(", ")
    ).toBe(true);
    const decision = buildTopicDecision({
      runId,
      researchCycle,
      validation: portfolioValidation,
      generatedAt: "2026-01-02T00:00:00.000Z"
    });
    expect(decision.disposition).toBe("probe_authorized");
    expect(decision.portfolio_content_sha256).toBe(
      resolution.portfolio?.content_sha256
    );

    const activeCandidate = resolution.portfolio?.candidates.find(
      (candidate) =>
        candidate.source_candidate_id === decision.probe_candidate_ids[0]
    );
    if (!resolution.portfolio || !activeCandidate) {
      throw new Error("authorized_topic_memory_candidate_missing");
    }
    const contract = buildActiveTopicProbeContract({
      runId,
      researchCycle,
      researchMode: "topic_discovery",
      portfolioContentSha256: resolution.portfolio.content_sha256,
      candidate: activeCandidate,
      deferredCandidateIds: decision.probe_candidate_ids.slice(1),
      generatedAt: "2026-01-02T00:00:01.000Z"
    });
    const contractValidation = validateActiveTopicProbeContract(
      JSON.stringify(contract),
      {
        expectedRunId: runId,
        expectedResearchCycle: researchCycle,
        portfolio: resolution.portfolio
      }
    );
    expect(
      contractValidation.valid,
      contractValidation.reasons.join(", ")
    ).toBe(true);
    expect(contract.portfolio_content_sha256).toBe(
      resolution.portfolio.content_sha256
    );
    expect(contract.candidate_content_sha256).toBe(
      activeCandidate.content_sha256
    );
    expect(activeCandidate.topic_memory?.ledger_sha256).toBe(
      currentLedger.ledger_sha256
    );
  });
});
