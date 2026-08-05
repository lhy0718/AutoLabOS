import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveConstraintProfile } from "../src/core/constraintProfile.js";
import {
  DEFAULT_COLLECT_PLANNING_TIMEOUT_MS,
  MAX_COLLECT_PLANNING_TIMEOUT_MS,
  resolveCollectPlanningTimeoutPolicy
} from "../src/core/collectPlanningPolicy.js";
import { InMemoryEventStream } from "../src/core/events.js";
import { MockLLMClient } from "../src/core/llm/client.js";
import { RunContextMemory } from "../src/core/memory/runContextMemory.js";
import {
  recordLiteratureQueryPlanRejection,
  resolveGeneratedLiteratureQueries
} from "../src/core/literatureQueryGeneration.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import {
  TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
  TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION
} from "../src/core/topicDiscoveryScientificTerms.js";
import type { RunRecord } from "../src/types.js";

class HangingLLMClient extends MockLLMClient {
  calls = 0;

  override async complete(): Promise<{ text: string }> {
    this.calls += 1;
    return await new Promise<{ text: string }>(() => {});
  }
}

class SequencedJsonLLMClient extends MockLLMClient {
  readonly prompts: string[] = [];

  constructor(private readonly responses: string[]) {
    super();
  }

  override async complete(prompt: string): Promise<{ text: string }> {
    this.prompts.push(prompt);
    const text = this.responses.shift();
    if (!text) {
      throw new Error("No planned LLM response remains.");
    }
    return { text };
  }
}

function buildRun(runId: string): RunRecord {
  return {
    version: 3,
    workflowVersion: 3,
    id: runId,
    title: "Timeout regression",
    topic: "Configuration parameter interaction",
    constraints: ["Use two GPUs", "Keep a named baseline and real metrics."],
    objectiveMetric: "Benchmark Task A and Benchmark Task B mean accuracy",
    status: "running",
    currentNode: "collect_papers",
    latestSummary: undefined,
    nodeThreads: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    graph: createDefaultGraphState(),
    memoryRefs: {
      runContextPath: `.autolabos/runs/${runId}/memory/run_context.json`,
      longTermPath: `.autolabos/runs/${runId}/memory/long_term.jsonl`,
      episodePath: `.autolabos/runs/${runId}/memory/episodes.jsonl`
    }
  };
}

function buildScopedTopicDiscoveryBrief(
  scopeAxes: string[],
  sharedAnchor = "document retrieval"
): string {
  return [
    "# Research Brief",
    "",
    "## Research Mode",
    "topic_discovery",
    "",
    "## Topic",
    `${sharedAnchor} under controlled judgments.`,
    "",
    "## Scientific Scope",
    "### Scientific Object",
    `- ${sharedAnchor}`,
    "",
    "### Empirical Problems",
    ...scopeAxes.map((axis) => `- ${axis}`),
    "- measurement validity under finite samples",
    "",
    "## Research Question",
    "Which declared scientific factors change comparative conclusions?",
    "",
    "## Dataset / Task / Bench",
    "Use item-level relevance judgments from a fixed corpus and distinguish an external query population.",
    ""
  ].join("\n");
}

describe("collect-time LLM helpers", () => {
  const originalConstraintTimeout = process.env.AUTOLABOS_CONSTRAINT_PROFILE_TIMEOUT_MS;
  const originalQueryTimeout = process.env.AUTOLABOS_LITERATURE_QUERY_TIMEOUT_MS;

  afterEach(() => {
    if (originalConstraintTimeout === undefined) {
      delete process.env.AUTOLABOS_CONSTRAINT_PROFILE_TIMEOUT_MS;
    } else {
      process.env.AUTOLABOS_CONSTRAINT_PROFILE_TIMEOUT_MS = originalConstraintTimeout;
    }
    if (originalQueryTimeout === undefined) {
      delete process.env.AUTOLABOS_LITERATURE_QUERY_TIMEOUT_MS;
    } else {
      process.env.AUTOLABOS_LITERATURE_QUERY_TIMEOUT_MS = originalQueryTimeout;
    }
  });

  it("uses closest-prior titles only as cache-bound planning hints", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-prior-hints-"));
    const runId = "run-query-prior-hints";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const response = JSON.stringify({
      shared_anchor: "document retrieval",
      families: [
        { axis: "confidence calibration" },
        { axis: "ranking variance" },
        { axis: "external population" }
      ],
      assumptions: []
    });
    const llm = new SequencedJsonLLMClient([response, response]);
    const input = {
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "confidence calibration under distribution shift",
        "ranking variance under finite samples",
        "external population generalization"
      ]),
      runContextMemory: new RunContextMemory(contextPath),
      llm
    };

    await resolveGeneratedLiteratureQueries({
      ...input,
      priorWorkProbeHints: [{
        probeId: "prior_probe_fixture",
        query: "review defect localization",
        candidateTitles: ["Traceable Review Defect Localization"]
      }]
    });
    await resolveGeneratedLiteratureQueries({
      ...input,
      priorWorkProbeHints: [{
        probeId: "prior_probe_fixture",
        query: "review defect localization",
        candidateTitles: ["Auditable Review Defect Localization"]
      }]
    });

    expect(llm.prompts).toHaveLength(2);
    expect(llm.prompts[0]).toContain("Separate closest-prior retrieval hints:");
    expect(llm.prompts[0]).toContain("Traceable Review Defect Localization");
    expect(llm.prompts[0]).toContain(
      "cannot authorize an axis, establish novelty, count as direct support, or enter the evidence corpus"
    );
    expect(llm.prompts[1]).toContain("Auditable Review Defect Localization");
  });

  it("preserves the brief anchor surface in planner and provider queries", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-anchor-surface-"));
    const runId = "run-query-anchor-surface";
    const contextPath = path.join(root, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const llm = new SequencedJsonLLMClient([
      JSON.stringify({
        shared_anchor: "automated peer review",
        families: [
          { axis: "defect detection" },
          { axis: "false positive" }
        ],
        assumptions: []
      })
    ]);

    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "controlled defect detection",
        "false positive control"
      ], "automated peer review"),
      runContextMemory: new RunContextMemory(contextPath),
      llm
    });

    expect(llm.prompts[0]).toContain(
      "Return this exact brief-declared shared anchor: automated peer review."
    );
    expect(llm.prompts[0]).not.toContain(
      "Return this exact brief-declared shared anchor: automat peer review."
    );
    expect(result?.queries).toEqual([
      '"automated peer review" defect detection',
      '"automated peer review" false positive'
    ]);
    expect(result?.scientificScopeDiagnostic).toMatchObject({
      declaredAnchorTerms: ["automat", "peer", "review"],
      queryAnchorTerms: ["automated", "peer", "review"],
      lockedAnchorTerms: ["automat", "peer", "review"],
      anchor: { passed: true }
    });
  });

  it("keeps partial configuration fixtures bounded when providers are omitted", () => {
    expect(resolveCollectPlanningTimeoutPolicy({})).toMatchObject({
      llm_mode: "codex",
      constraint_profile_timeout_ms: DEFAULT_COLLECT_PLANNING_TIMEOUT_MS,
      literature_query_timeout_ms: DEFAULT_COLLECT_PLANNING_TIMEOUT_MS
    });
  });

  it.each(["codex", "codex_chatgpt_only", "openai_api", "ollama"] as const)(
    "uses the bounded collect-planning default for %s",
    (llmMode) => {
      const policy = resolveCollectPlanningTimeoutPolicy(
        { providers: { llm_mode: llmMode } } as any,
        {}
      );

      expect(policy).toEqual({
        llm_mode: llmMode,
        constraint_profile_timeout_ms: DEFAULT_COLLECT_PLANNING_TIMEOUT_MS,
        literature_query_timeout_ms: DEFAULT_COLLECT_PLANNING_TIMEOUT_MS,
        constraint_profile_source: "bounded_default",
        literature_query_source: "bounded_default"
      });
    }
  );

  it("uses bounded environment overrides and records their source", () => {
    const policy = resolveCollectPlanningTimeoutPolicy(
      { providers: { llm_mode: "codex_chatgpt_only" } } as any,
      {
        AUTOLABOS_CONSTRAINT_PROFILE_TIMEOUT_MS: "75000",
        AUTOLABOS_LITERATURE_QUERY_TIMEOUT_MS: "999999"
      }
    );

    expect(policy).toEqual({
      llm_mode: "codex_chatgpt_only",
      constraint_profile_timeout_ms: 75_000,
      literature_query_timeout_ms: MAX_COLLECT_PLANNING_TIMEOUT_MS,
      constraint_profile_source: "environment_override",
      literature_query_source: "environment_override"
    });
  });

  it("falls back to heuristic constraint profile when the LLM hangs", async () => {
    process.env.AUTOLABOS_CONSTRAINT_PROFILE_TIMEOUT_MS = "5";

    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-constraint-timeout-"));
    const runId = "run-timeout-constraint";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");

    const memory = new RunContextMemory(contextPath);
    const eventStream = new InMemoryEventStream();
    const run = buildRun(runId);

    const profile = await resolveConstraintProfile({
      run,
      runContextMemory: memory,
      llm: new HangingLLMClient(),
      eventStream,
      node: "collect_papers"
    });

    expect(profile.source).toBe("heuristic_fallback");
    const snapshot = JSON.parse(await readFile(contextPath, "utf8")) as {
      items: Array<{ key: string; value: { profile?: { source?: string } } }>;
    };
    expect(
      snapshot.items.find((entry) => entry.key === "constraints.profile")?.value?.profile?.source
    ).toBe("heuristic_fallback");
    expect(
      eventStream.history().some((event) => JSON.stringify(event).includes("constraint_profile_timeout_after_5ms"))
    ).toBe(true);
  });

  it("honors a run-scoped constraint timeout ahead of the process default", async () => {
    process.env.AUTOLABOS_CONSTRAINT_PROFILE_TIMEOUT_MS = "5000";

    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-constraint-explicit-timeout-"));
    const runId = "run-explicit-timeout-constraint";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");

    const eventStream = new InMemoryEventStream();
    const profile = await resolveConstraintProfile({
      run: buildRun(runId),
      runContextMemory: new RunContextMemory(contextPath),
      llm: new HangingLLMClient(),
      eventStream,
      node: "collect_papers",
      timeoutMs: 5
    });

    expect(profile.source).toBe("heuristic_fallback");
    expect(
      eventStream.history().some((event) => JSON.stringify(event).includes("constraint_profile_timeout_after_5ms"))
    ).toBe(true);
  });

  it("falls back from generated literature queries when the LLM hangs", async () => {
    process.env.AUTOLABOS_LITERATURE_QUERY_TIMEOUT_MS = "5";

    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-timeout-"));
    const runId = "run-timeout-query";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");

    const memory = new RunContextMemory(contextPath);
    const eventStream = new InMemoryEventStream();
    const run = buildRun(runId);

    const hangingLlm = new HangingLLMClient();
    const result = await resolveGeneratedLiteratureQueries({
      run,
      rawBrief: "# Research Brief\n\n## Topic\nAdapter parameter interaction\n",
      extractedBriefTopic: "Configuration parameter interaction",
      runContextMemory: memory,
      llm: hangingLlm,
      eventStream,
      node: "collect_papers"
    });

    expect(result).toEqual({
      source: "deterministic_fallback",
      queries: [],
      assumptions: [],
      failureReason: "literature_query_timeout_after_5ms"
    });
    expect(
      eventStream.history().some((event) => JSON.stringify(event).includes("literature_query_timeout_after_5ms"))
    ).toBe(true);
    expect(hangingLlm.calls).toBe(1);

    delete process.env.AUTOLABOS_LITERATURE_QUERY_TIMEOUT_MS;
    const callerOverrideEvents = new InMemoryEventStream();
    const callerOverrideLlm = new HangingLLMClient();
    const callerOverrideResult = await resolveGeneratedLiteratureQueries({
      run,
      rawBrief: "# Research Brief\n\n## Topic\nAdapter parameter interaction\n",
      extractedBriefTopic: "Configuration parameter interaction",
      runContextMemory: memory,
      llm: callerOverrideLlm,
      eventStream: callerOverrideEvents,
      node: "collect_papers",
      timeoutMs: 7
    });

    expect(callerOverrideResult?.failureReason).toBe("literature_query_timeout_after_7ms");
    expect(
      callerOverrideEvents.history().some((event) =>
        JSON.stringify(event).includes("literature_query_timeout_after_7ms")
      )
    ).toBe(true);
    expect(callerOverrideLlm.calls).toBe(1);
  });

  it("compiles unused explicit scope axes when topic planning times out", async () => {
    process.env.AUTOLABOS_LITERATURE_QUERY_TIMEOUT_MS = "5";

    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-scope-timeout-"));
    const runId = "run-scope-timeout-query";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const memory = new RunContextMemory(contextPath);
    await recordLiteratureQueryPlanRejection(memory, {
      rejectedQueries: ['"automated peer review" confidence calibration'],
      qualityReasons: ["No direct-support papers met the family floor."],
      sharedAnchorTerms: ["automated", "peer", "review"],
      candidateTitles: [],
      queryFamilies: [{
        queryFamily: "topic_family_1",
        query: '"automated peer review" external population validity',
        axisTerms: ["external", "population", "validity"],
        relevantPaperCount: 0
      }],
      scientificScopeFingerprint: undefined
    });
    const eventStream = new InMemoryEventStream();
    const llm = new HangingLLMClient();

    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "confidence calibration under distribution shift",
        "stateful interaction robustness",
        "annotation disagreement stability",
        "external population validity"
      ], "automated peer review"),
      runContextMemory: memory,
      llm,
      eventStream,
      node: "collect_papers",
      priorWorkProbeHints: [{
        probeId: "prior_probe_fixture",
        query: "stateful interaction robustness",
        candidateTitles: [
          "Stateful Interaction Robustness for Automated Peer Review",
          "Automated Peer Review under Stateful Interaction Robustness"
        ]
      }]
    });

    expect(result).toMatchObject({
      source: "deterministic_fallback",
      queries: [
        '"automated peer review" stateful interaction robustness',
        '"automated peer review" annotation disagreement stability'
      ],
      repairDiagnostic: {
        strategy: "explicit_scope_timeout_fallback",
        selectedScopeAxisIds: expect.any(Array),
        excludedRejectedScopeAxisIds: expect.any(Array),
        queryabilityTitleSource:
          "executed_candidates_plus_prior_work_probe_hints",
        finalCorpusGateUnchanged: true
      }
    });
    expect(result?.failureReason).toBeUndefined();
    expect(result?.topicDiscoveryPlan?.families).toHaveLength(2);
    expect(result?.topicDiscoveryPlan?.families.every(
      (family) => family.contractSource === "bounded_inference"
    )).toBe(true);
    expect(result?.queries).not.toContain(
      '"automated peer review" confidence calibration'
    );
    expect(
      eventStream.history().some((event) =>
        JSON.stringify(event).includes(
          "Prior-work titles affected queryability ranking only"
        )
      )
    ).toBe(true);
    expect(llm.calls).toBe(1);
  });

  it("preserves the contract rejection when a compiled timeout fallback is inadmissible", async () => {
    process.env.AUTOLABOS_LITERATURE_QUERY_TIMEOUT_MS = "5";

    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-scope-rejected-"));
    const runId = "run-scope-rejected-query";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const memory = new RunContextMemory(contextPath);
    await recordLiteratureQueryPlanRejection(memory, {
      rejectedQueries: ['"document retrieval" prior baseline failure'],
      qualityReasons: ["The previous retrieval portfolio failed."],
      sharedAnchorTerms: ["document", "retrieval"],
      candidateTitles: [
        "Stateful Interaction Robustness for Document Retrieval"
      ],
      queryFamilies: [],
      scientificScopeFingerprint: undefined
    });
    const eventStream = new InMemoryEventStream();
    const llm = new HangingLLMClient();

    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "stateful interaction robustness",
        "annotation disagreement stability"
      ]),
      runContextMemory: memory,
      llm,
      eventStream,
      node: "collect_papers"
    });

    expect(result).toMatchObject({
      source: "deterministic_fallback",
      queries: [],
      failureReason: expect.stringContaining(
        "explicit_scope_timeout_fallback_rejected:literature_query_plan_candidate_title_support_below_floor:"
      ),
      repairDiagnostic: {
        strategy: "explicit_scope_timeout_fallback_rejected",
        sourceAttempt: 1,
        selectedScopeAxisIds: expect.any(Array),
        excludedRejectedScopeAxisIds: [],
        validationFailureReason: expect.stringContaining(
          "literature_query_plan_candidate_title_support_below_floor:"
        ),
        queryabilityTitleSource:
          "executed_candidates_plus_prior_work_probe_hints",
        finalCorpusGateUnchanged: true
      }
    });
    expect(
      eventStream.history().some((event) =>
        JSON.stringify(event).includes(
          "Deterministic explicit-scope timeout fallback was unavailable"
        )
      )
    ).toBe(true);
    expect(llm.calls).toBe(1);
  });

  it("explains why an explicit-scope timeout fallback has no admissible portfolio", async () => {
    process.env.AUTOLABOS_LITERATURE_QUERY_TIMEOUT_MS = "5";

    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-scope-exhausted-"));
    const runId = "run-scope-exhausted-query";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const memory = new RunContextMemory(contextPath);
    await recordLiteratureQueryPlanRejection(memory, {
      rejectedQueries: [
        '"document retrieval" confidence calibration',
        '"document retrieval" stateful interaction robustness',
        '"document retrieval" annotation disagreement stability',
        '"document retrieval" external population validity'
      ],
      qualityReasons: ["Every executed family missed the direct-support floor."],
      sharedAnchorTerms: ["document", "retrieval"],
      candidateTitles: ["Document Retrieval: A General Overview"],
      queryFamilies: [],
      scientificScopeFingerprint: undefined
    });
    const eventStream = new InMemoryEventStream();
    const llm = new HangingLLMClient();

    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "confidence calibration",
        "stateful interaction robustness",
        "annotation disagreement stability",
        "external population validity"
      ]),
      runContextMemory: memory,
      llm,
      eventStream,
      node: "collect_papers"
    });

    expect(result).toMatchObject({
      source: "deterministic_fallback",
      queries: [],
      failureReason: expect.stringContaining(
        "explicit_scope_timeout_fallback_unavailable:insufficient_unused_scope_axes"
      ),
      repairDiagnostic: {
        strategy: "explicit_scope_timeout_fallback_unavailable",
        reason: "insufficient_unused_scope_axes",
        requiredFamilyCount: 2,
        eligibleCandidateCount: 1,
        titleSupportedCandidateCount: 0,
        excludedRejectedScopeAxisIds: expect.any(Array),
        queryabilityTitleSource:
          "executed_candidates_plus_prior_work_probe_hints",
        finalCorpusGateUnchanged: true
      }
    });
    expect(
      eventStream.history().some((event) =>
        JSON.stringify(event).includes(
          "deterministic explicit-scope timeout fallback was unavailable"
        )
      )
    ).toBe(true);
    expect(llm.calls).toBe(1);
  });

  it("replans once when the first topic-discovery anchor is structurally too broad", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-anchor-replan-"));
    const runId = "run-query-anchor-replan";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const llm = new SequencedJsonLLMClient([
      JSON.stringify({
        shared_anchor: "language model evaluation reliability",
        families: [
          { axis: "statistical power" },
          { axis: "ranking variance" }
        ],
        operator_context: "diagnostic-must-not-copy-this-field",
        assumptions: []
      }),
      JSON.stringify({
        shared_anchor: "language model evaluation",
        families: [
          { axis: "confidence calibration" },
          { axis: "distribution shift" },
          { axis: "external population" }
        ],
        assumptions: []
      })
    ]);

    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "statistical power for finite samples",
        "confidence calibration under distribution shift",
        "external population generalization",
        "ranking variance under finite samples"
      ], "language model evaluation"),
      runContextMemory: new RunContextMemory(contextPath),
      llm
    });

    expect(llm.prompts).toHaveLength(2);
    expect(llm.prompts[1]).toContain("no usable Semantic Scholar queries");
    expect(result?.source).toBe("llm");
    expect(result?.attemptDiagnostics).toMatchObject([
      expect.objectContaining({
        attempt: 1,
        status: "rejected_structure",
        sharedAnchorTerms: ["language", "model", "evaluation", "reliability"]
      }),
      expect.objectContaining({ attempt: 2, status: "accepted" })
    ]);
    expect(JSON.stringify(result?.attemptDiagnostics)).not.toContain(
      "diagnostic-must-not-copy-this-field"
    );
  });

  it("replans once when operational axes leave only one usable family", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-family-replan-"));
    const runId = "run-query-family-replan";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const llm = new SequencedJsonLLMClient([
      JSON.stringify({
        shared_anchor: "language model evaluation",
        families: [
          { axis: "statistical power" },
          { axis: "local execution performance metrics" }
        ],
        assumptions: []
      }),
      JSON.stringify({
        shared_anchor: "language model evaluation",
        families: [
          { axis: "confidence calibration" },
          { axis: "distribution shift" },
          { axis: "external population" }
        ],
        assumptions: []
      })
    ]);

    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "statistical power for finite samples",
        "confidence calibration under distribution shift",
        "external population generalization"
      ], "language model evaluation"),
      runContextMemory: new RunContextMemory(contextPath),
      llm
    });

    expect(llm.prompts).toHaveLength(2);
    expect(llm.prompts[0]).toContain("Authoritative scientific-scope contract");
    expect(llm.prompts[0]).toContain("confidence, calibration, distribution, shift");
    expect(llm.prompts[0]).toContain("external, population, generalization");
    expect(llm.prompts[1]).toContain("Replace every structurally invalid or meta-only family");
    expect(llm.prompts[1]).toContain("changing one generic word does not repair it");
    expect(result?.queries).toEqual([
      '"language model evaluation" confidence calibration',
      '"language model evaluation" distribution shift',
      '"language model evaluation" external population'
    ]);
    expect(result?.attemptDiagnostics?.[0]).toMatchObject({
      attempt: 1,
      status: "rejected_structure",
      failureReason: expect.stringContaining("1 independent literature query family")
    });
  });

  it("reports overlong topic-discovery axes precisely so the bounded replan can compact them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-axis-length-replan-"));
    const runId = "run-query-axis-length-replan";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const llm = new SequencedJsonLLMClient([
      JSON.stringify({
        shared_anchor: "document retrieval evaluation",
        families: [
          { axis: "statistical power" },
          { axis: "fixed benchmark census external population generalization" },
          { axis: "family task independence uncertainty claim" }
        ],
        assumptions: []
      }),
      JSON.stringify({
        shared_anchor: "document retrieval evaluation",
        families: [
          { axis: "statistical power" },
          { axis: "external population generalization" },
          { axis: "task independence uncertainty" }
        ],
        assumptions: []
      })
    ]);

    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "statistical power under finite samples",
        "fixed benchmark census external population generalization",
        "family task independence uncertainty claim"
      ], "document retrieval evaluation"),
      runContextMemory: new RunContextMemory(contextPath),
      llm
    });

    expect(llm.prompts).toHaveLength(2);
    expect(llm.prompts[1]).toContain("topic_family_2 has 6 axis terms (requires 2-3)");
    expect(llm.prompts[1]).toContain("topic_family_3 has 5 axis terms (requires 2-3)");
    expect(result?.queries).toEqual([
      '"document retrieval evaluation" statistical power',
      '"document retrieval evaluation" external population generalization',
      '"document retrieval evaluation" task independence uncertainty'
    ]);
  });

  it("applies a transparent bounded repair only after both structured attempts remain overlong", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-bounded-axis-repair-"));
    const runId = "run-query-bounded-axis-repair";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const overlongPlan = JSON.stringify({
      shared_anchor: "document retrieval evaluation",
      families: [
        { axis: "statistical reliability limited budgets" },
        { axis: "fixed benchmark census external population generalization" },
        { axis: "annotation disagreement variance local execution" }
      ],
      assumptions: []
    });
    const llm = new SequencedJsonLLMClient([overlongPlan, overlongPlan]);

    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "statistical reliability under limited budgets",
        "fixed benchmark census external population generalization",
        "annotation disagreement variance"
      ], "document retrieval evaluation"),
      runContextMemory: new RunContextMemory(contextPath),
      llm
    });

    expect(llm.prompts).toHaveLength(2);
    expect(result?.source).toBe("llm_bounded_repair");
    expect(result?.queries).toEqual([
      '"document retrieval evaluation" statistical reliability',
      '"document retrieval evaluation" fixed census generalization',
      '"document retrieval evaluation" annotation disagreement variance'
    ]);
    expect(result?.repairDiagnostic).toMatchObject({
      strategy: "remove_non_substantive_then_preserve_axis_boundaries",
      sourceAttempt: 2,
      families: [
        expect.objectContaining({
          retainedAxisTerms: ["statistical", "reliability"],
          droppedAxisTerms: ["limited", "budgets"]
        }),
        expect.objectContaining({
          retainedAxisTerms: ["fixed", "census", "generalization"],
          droppedAxisTerms: ["benchmark", "external", "population"]
        }),
        expect.objectContaining({
          retainedAxisTerms: ["annotation", "disagreement", "variance"],
          droppedAxisTerms: ["local", "execution"]
        })
      ]
    });
  });

  it("rejects topic-discovery plans whose families are only execution qualifiers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-contract-"));
    const runId = "run-query-contract";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");

    const invalidPlan = JSON.stringify({
        shared_anchor: "document retrieval evaluation",
        families: [
          { axis: "limited local budget" },
          { axis: "reproducible local execution" }
        ],
        assumptions: []
      });
    const llm = new SequencedJsonLLMClient([invalidPlan, invalidPlan]);
    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "statistical reliability under finite samples",
        "distribution shift under external populations"
      ], "document retrieval evaluation"),
      runContextMemory: new RunContextMemory(contextPath),
      llm
    });

    expect(result).toMatchObject({
      source: "deterministic_fallback",
      queries: []
    });
    expect(result?.failureReason).toContain("no usable Semantic Scholar queries");
    expect(llm.prompts).toHaveLength(2);
    expect(llm.prompts[0]).toContain("2 to 3 terms");
    expect(llm.prompts[0]).toContain("local-execution");
  });

  it("invalidates a rejected query-plan cache and supplies corpus feedback to the next attempt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-feedback-"));
    const runId = "run-query-feedback";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");

    const memory = new RunContextMemory(contextPath);
    const llm = new SequencedJsonLLMClient([
      JSON.stringify({
        shared_anchor: "document retrieval",
        families: [
          { axis: "uncertainty calibration" },
          { axis: "distribution shift" }
        ],
        assumptions: []
      }),
      JSON.stringify({
        shared_anchor: "document retrieval",
        families: [
          { axis: "label efficiency" },
          { axis: "evaluation stability" }
        ],
        assumptions: []
      })
    ]);
    const rawBrief = buildScopedTopicDiscoveryBrief([
      "uncertainty calibration",
      "distribution shift",
      "label efficiency",
      "evaluation stability"
    ]);

    const first = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief,
      runContextMemory: memory,
      llm
    });
    await recordLiteratureQueryPlanRejection(memory, {
      rejectedQueries: first?.queries ?? [],
      qualityReasons: ["Insufficient topic-relevant corpus."],
      sharedAnchorTerms: ["document", "retrieval"],
      candidateTitles: [
        "Label efficiency in document retrieval evaluation",
        "Document retrieval label efficiency analysis",
        "Evaluation stability for document retrieval systems",
        "Document retrieval evaluation stability audit"
      ],
      queryFamilies: (first?.queries ?? []).map((query) => ({ query, axisTerms: ["calibration"] }))
    });
    const second = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief,
      runContextMemory: memory,
      llm
    });

    expect(llm.prompts).toHaveLength(2);
    expect(llm.prompts[1]).toContain("Previous retrieval-plan rejection:");
    expect(llm.prompts[1]).toContain("Insufficient topic-relevant corpus.");
    expect(llm.prompts[1]).toContain("Label efficiency in document retrieval evaluation");
    expect(llm.prompts[1]).toContain("vocabulary hints only, not accepted evidence");
    expect(second?.queries).toEqual([
      '"document retrieval" label efficiency',
      '"document retrieval" evaluation stability'
    ]);
    expect(second?.topicDiscoveryPlan).toMatchObject({
      sharedAnchorTerms: ["document", "retrieval"],
      families: [
        expect.objectContaining({ axisTerms: ["label", "efficiency"] }),
        expect.objectContaining({ axisTerms: ["evaluation", "stability"] })
      ]
    });
  });

  it("preserves an executed supported family while replacing only failed family slots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-supported-family-"));
    const runId = "run-query-supported-family";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const memory = new RunContextMemory(contextPath);
    const supportedFamilyId = "family-ranking-stability";
    const supportedQuery = '"document retrieval" ranking stability';
    const failedQuery = '"document retrieval" calibration error';
    const recorded = await recordLiteratureQueryPlanRejection(memory, {
      rejectedQueries: [supportedQuery, failedQuery],
      qualityReasons: ["One independent family remained below the evidence floor."],
      sharedAnchorTerms: ["document", "retrieval"],
      candidateTitles: [
        "Document retrieval annotation disagreement analysis",
        "Annotation disagreement in document retrieval systems"
      ],
      queryFamilies: [
        {
          queryFamily: supportedFamilyId,
          query: supportedQuery,
          axisTerms: ["ranking", "stability"],
          lens: "Direct measurement of ranking stability",
          contributionIntent: "measurement",
          contractSource: "planner_declared",
          relevantPaperCount: 8
        },
        { query: failedQuery, axisTerms: ["calibration", "error"], relevantPaperCount: 0 }
      ],
      supportedQueryFamilies: [
        {
          queryFamily: supportedFamilyId,
          query: supportedQuery,
          axisTerms: ["ranking", "stability"],
          lens: "Direct measurement of ranking stability",
          contributionIntent: "measurement",
          contractSource: "planner_declared",
          relevantPaperCount: 8
        }
      ]
    });
    expect(recorded.rejectedQueries).toEqual([failedQuery]);
    expect(recorded.supportedQueryFamilies).toEqual([
      expect.objectContaining({
        queryFamily: supportedFamilyId,
        lens: "Direct measurement of ranking stability",
        contributionIntent: "measurement"
      })
    ]);

    const llm = new SequencedJsonLLMClient([
      JSON.stringify({
        shared_anchor: "document retrieval",
        families: [
          { axis: "annotation disagreement" },
          { axis: "distribution shift" },
          { axis: "sample efficiency" }
        ],
        assumptions: []
      })
    ]);
    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "ranking stability",
        "calibration error",
        "annotation disagreement",
        "distribution shift",
        "sample efficiency"
      ]),
      runContextMemory: memory,
      llm
    });

    expect(llm.prompts).toHaveLength(1);
    expect(llm.prompts[0]).toContain(
      `Executed families that already met the per-family relevance floor: ${supportedFamilyId} [`
    );
    expect(llm.prompts[0]).toContain(
      `${supportedQuery}; lens=Direct measurement of ranking stability; intent=measurement (8 relevant papers)`
    );
    expect(result?.source).toBe("llm_bounded_repair");
    expect(result?.queries).toEqual([
      supportedQuery,
      '"document retrieval" annotation disagreement',
      '"document retrieval" distribution shift'
    ]);
    expect(result?.queries).not.toContain(failedQuery);
    expect(result?.topicDiscoveryPlan?.families).toContainEqual(
      expect.objectContaining({
        id: supportedFamilyId,
        query: supportedQuery,
        lens: "Direct measurement of ranking stability",
        contributionIntent: "measurement",
        contractSource: "planner_declared"
      })
    );
    expect(result?.attemptDiagnostics?.[0]).toMatchObject({
      feedbackFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      feedback: {
        supportedQueryFamilies: [
          expect.objectContaining({
            queryFamily: supportedFamilyId,
            query: supportedQuery,
            contractFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
          })
        ]
      }
    });
    expect(result?.repairDiagnostic).toMatchObject({
      strategy: "preserve_executed_family_replace_failed_only",
      sourceAttempt: 1,
      preservedQueries: [supportedQuery],
      finalCorpusGateUnchanged: true
    });
  });

  it("does not inherit support when a stable family id is attached to a changed contract", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-contract-drift-"));
    const runId = "run-query-contract-drift";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const memory = new RunContextMemory(contextPath);
    const queryFamily = "family-stable-id";
    const query = '"document retrieval" ranking stability';

    const first = await recordLiteratureQueryPlanRejection(memory, {
      rejectedQueries: [],
      qualityReasons: [],
      sharedAnchorTerms: ["document", "retrieval"],
      candidateTitles: [],
      queryFamilies: [{
        queryFamily,
        query,
        axisTerms: ["ranking", "stability"],
        lens: "Direct measurement of ranking stability",
        contributionIntent: "measurement",
        contractSource: "planner_declared",
        relevantPaperCount: 8
      }],
      supportedQueryFamilies: [{
        queryFamily,
        query,
        axisTerms: ["ranking", "stability"],
        lens: "Direct measurement of ranking stability",
        contributionIntent: "measurement",
        contractSource: "planner_declared",
        relevantPaperCount: 8
      }]
    });
    const firstFingerprint = first.supportedQueryFamilies?.[0]?.contractFingerprint;

    const second = await recordLiteratureQueryPlanRejection(memory, {
      rejectedQueries: [query],
      qualityReasons: ["The revised family contract has no direct support."],
      sharedAnchorTerms: ["document", "retrieval"],
      candidateTitles: [],
      queryFamilies: [{
        queryFamily,
        query,
        axisTerms: ["ranking", "stability"],
        lens: "Application-only ranking reports",
        contributionIntent: "empirical_finding",
        contractSource: "planner_declared",
        relevantPaperCount: 0
      }],
      supportedQueryFamilies: []
    });

    expect(firstFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.supportedQueryFamilies).toEqual([]);
    expect(second.rejectedQueries).toEqual([query]);
    expect(second.queryFamilies).toEqual([
      expect.objectContaining({
        queryFamily,
        lens: "Application-only ranking reports",
        contributionIntent: "empirical_finding",
        relevantPaperCount: 0,
        contractFingerprint: expect.not.stringMatching(firstFingerprint ?? "")
      })
    ]);
  });

  it("accumulates candidate-title feedback across bounded collection failures", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-feedback-history-"));
    const runId = "run-query-feedback-history";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const memory = new RunContextMemory(contextPath);

    await recordLiteratureQueryPlanRejection(memory, {
      rejectedQueries: ['"document retrieval" uncertainty calibration'],
      qualityReasons: ["First bounded failure."],
      sharedAnchorTerms: ["document", "retrieval"],
      candidateTitles: [
        "Document retrieval ranking stability evaluation",
        "Ranking stability in document retrieval systems"
      ],
      queryFamilies: []
    });
    await recordLiteratureQueryPlanRejection(memory, {
      rejectedQueries: ['"document retrieval" distribution shift'],
      qualityReasons: ["Second bounded failure."],
      sharedAnchorTerms: ["document", "retrieval"],
      candidateTitles: [
        "Document retrieval annotation disagreement analysis",
        "Annotation disagreement for document retrieval labels"
      ],
      queryFamilies: []
    });

    const stored = await memory.get<{
      rejectedQueries?: string[];
      qualityReasons?: string[];
      candidateTitles?: string[];
    }>("collect_papers.llm_query_plan_feedback");
    expect(stored).toMatchObject({
      rejectedQueries: [
        '"document retrieval" distribution shift',
        '"document retrieval" uncertainty calibration'
      ],
      qualityReasons: ["Second bounded failure.", "First bounded failure."],
      candidateTitles: [
        "Document retrieval ranking stability evaluation",
        "Ranking stability in document retrieval systems",
        "Document retrieval annotation disagreement analysis",
        "Annotation disagreement for document retrieval labels"
      ]
    });
  });

  it("reserves bounded feedback capacity for new titles after history reaches its cap", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-feedback-cap-"));
    const runId = "run-query-feedback-cap";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const memory = new RunContextMemory(contextPath);
    const historicalTitles = Array.from(
      { length: 18 },
      (_, index) => `Document retrieval historical title ${String.fromCharCode(65 + index)}`
    );
    const latestTitles = [
      "Document retrieval calibration shift",
      "Document retrieval paired uncertainty",
      "Document retrieval annotation variance",
      "Document retrieval ranking instability"
    ];

    await recordLiteratureQueryPlanRejection(memory, {
      rejectedQueries: ['"document retrieval" historical analysis'],
      qualityReasons: ["Initial bounded failure."],
      sharedAnchorTerms: ["document", "retrieval"],
      candidateTitles: historicalTitles,
      queryFamilies: []
    });
    await recordLiteratureQueryPlanRejection(memory, {
      rejectedQueries: ['"document retrieval" uncertainty analysis'],
      qualityReasons: ["Latest bounded failure."],
      sharedAnchorTerms: ["document", "retrieval"],
      candidateTitles: latestTitles,
      queryFamilies: []
    });

    const stored = await memory.get<{ candidateTitles?: string[] }>(
      "collect_papers.llm_query_plan_feedback"
    );
    expect(stored?.candidateTitles).toHaveLength(18);
    expect(stored?.candidateTitles).toEqual(expect.arrayContaining(latestTitles));
    expect(stored?.candidateTitles?.some((title) => historicalTitles.includes(title))).toBe(true);
  });

  it("replans before retrieval when candidate titles support no repeated axis", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-title-support-"));
    const runId = "run-query-title-support";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const memory = new RunContextMemory(contextPath);
    await recordLiteratureQueryPlanRejection(memory, {
      rejectedQueries: ['"document retrieval" uncertainty calibration'],
      qualityReasons: ["The previous corpus did not meet the family floor."],
      sharedAnchorTerms: ["document", "retrieval"],
      candidateTitles: [
        "Document retrieval ranking stability evaluation",
        "Ranking stability in document retrieval systems",
        "Document retrieval annotation disagreement analysis",
        "Annotation disagreement for document retrieval labels"
      ],
      queryFamilies: []
    });
    const llm = new SequencedJsonLLMClient([
      JSON.stringify({
        shared_anchor: "document retrieval",
        families: [
          { axis: "paired bootstrap" },
          { axis: "overfitting sensitivity" },
          { axis: "sample efficiency" }
        ],
        assumptions: []
      }),
      JSON.stringify({
        shared_anchor: "document retrieval",
        families: [
          { axis: "ranking stability" },
          { axis: "annotation disagreement" },
          { axis: "domain transfer" }
        ],
        assumptions: []
      })
    ]);

    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "paired bootstrap",
        "overfitting sensitivity",
        "sample efficiency",
        "ranking stability",
        "annotation disagreement",
        "domain transfer"
      ]),
      runContextMemory: memory,
      llm
    });

    expect(llm.prompts).toHaveLength(2);
    expect(llm.prompts[1]).toContain(
      "literature_query_plan_candidate_title_support_below_floor"
    );
    expect(result?.queries).toEqual([
      '"document retrieval" ranking stability',
      '"document retrieval" annotation disagreement',
      '"document retrieval" domain transfer'
    ]);
    expect(result?.attemptDiagnostics).toEqual([
      expect.objectContaining({ attempt: 1, status: "rejected_feedback" }),
      expect.objectContaining({ attempt: 2, status: "accepted" })
    ]);
  });

  it("keeps the executed shared anchor immutable during bounded recovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-anchor-continuity-"));
    const runId = "run-query-anchor-continuity";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const memory = new RunContextMemory(contextPath);
    await recordLiteratureQueryPlanRejection(memory, {
      rejectedQueries: ['"document retrieval" uncertainty calibration'],
      qualityReasons: ["The previous corpus did not meet the family floor."],
      sharedAnchorTerms: ["document", "retrieval"],
      candidateTitles: [
        "Document retrieval ranking stability evaluation",
        "Ranking stability in document retrieval systems",
        "Document retrieval annotation disagreement analysis",
        "Annotation disagreement for document retrieval labels"
      ],
      queryFamilies: []
    });
    const llm = new SequencedJsonLLMClient([
      JSON.stringify({
        shared_anchor: "retrieval systems",
        families: [
          { axis: "ranking stability" },
          { axis: "annotation disagreement" },
          { axis: "domain transfer" }
        ],
        assumptions: []
      }),
      JSON.stringify({
        shared_anchor: "document retrieval",
        families: [
          { axis: "ranking stability" },
          { axis: "annotation disagreement" },
          { axis: "domain transfer" }
        ],
        assumptions: []
      })
    ]);

    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "ranking stability",
        "annotation disagreement",
        "domain transfer"
      ]),
      runContextMemory: memory,
      llm
    });

    expect(llm.prompts).toHaveLength(2);
    expect(llm.prompts[1]).toContain(
      "The executed shared anchor is immutable for this recovery generation: return exactly document retrieval."
    );
    expect(result?.attemptDiagnostics?.[0]).toMatchObject({
      status: "rejected_feedback",
      failureReason: expect.stringContaining(
        "literature_query_plan_shared_anchor_drift:"
      )
    });
    expect(result?.queries).toEqual([
      '"document retrieval" ranking stability',
      '"document retrieval" annotation disagreement',
      '"document retrieval" domain transfer'
    ]);
  });

  it("rejects title-driven topic drift and requires source-bound technical expansion", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-scientific-scope-"));
    const runId = "run-query-scientific-scope";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const memory = new RunContextMemory(contextPath);
    await recordLiteratureQueryPlanRejection(memory, {
      rejectedQueries: ['"document retrieval" uncertainty calibration'],
      qualityReasons: ["The previous corpus did not meet the family floor."],
      sharedAnchorTerms: ["document", "retrieval"],
      candidateTitles: [
        "Adjacent mitigation for document retrieval systems",
        "Document retrieval adjacent mitigation audit",
        "Document retrieval ranking stability evaluation",
        "Ranking stability in document retrieval systems",
        "Document retrieval annotation disagreement analysis",
        "Annotation disagreement for document retrieval labels",
        "Finite census inference for document retrieval evaluation",
        "Document retrieval under finite census measurement",
        "External population validity in document retrieval",
        "Document retrieval conclusions for an external population",
        "Item response theory for document retrieval decisions",
        "Document retrieval evaluation with item response theory"
      ],
      queryFamilies: []
    });
    const llm = new SequencedJsonLLMClient([
      JSON.stringify({
        shared_anchor: "document retrieval",
        families: [
          {
            axis: "adjacent mitigation",
            lens: "Measures factuality errors and auditable grading outcomes for decision reliability.",
            contribution_intent: "measurement"
          },
          { axis: "ranking stability" },
          { axis: "annotation disagreement" }
        ],
        assumptions: []
      }),
      JSON.stringify({
        shared_anchor: "document retrieval",
        families: [
          { axis: "finite census" },
          { axis: "external population" },
          {
            axis: "item response theory",
            lens: "Uses item responses to test whether reduced corpus sampling preserves reliability.",
            contribution_intent: "method"
          }
        ],
        assumptions: []
      })
    ]);
    const rawBrief = buildScopedTopicDiscoveryBrief([
      "ranking stability under annotation disagreement",
      "finite census under fixed judgments",
      "external population generalization",
      "item uncertainty under finite samples"
    ]);

    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief,
      runContextMemory: memory,
      llm
    });

    expect(llm.prompts).toHaveLength(2);
    expect(llm.prompts[1]).toContain(
      "literature_query_plan_scientific_scope_rejected:"
    );
    expect(result?.attemptDiagnostics?.[0]).toMatchObject({
      status: "rejected_feedback",
      failureReason: expect.stringContaining(
        "topic_family_1=no_brief_axis_lineage"
      ),
      scientificScopeDiagnostic: expect.objectContaining({
        enforced: true,
        status: "failed"
      })
    });
    expect(result?.queries).toEqual([
      '"document retrieval" finite census',
      '"document retrieval" external population',
      '"document retrieval" item response theory'
    ]);
    expect(result?.scientificScopeDiagnostic).toMatchObject({
      enforced: true,
      status: "passed",
      lockedAnchorTerms: ["document", "retrieval"],
      families: expect.arrayContaining([
        expect.objectContaining({
          axisTerms: ["item", "response", "theory"],
          relation: "technical_expansion",
          retainedSourceTerms: ["item"],
          novelTerms: ["response", "theory"],
          candidateTitleSupport: 2,
          passed: true
        })
      ])
    });
  });

  it("allows one bounded exploratory family beside a repeatedly title-supported axis", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-exploratory-family-"));
    const runId = "run-query-exploratory-family";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const memory = new RunContextMemory(contextPath);
    await recordLiteratureQueryPlanRejection(memory, {
      rejectedQueries: ['"document retrieval" uncertainty calibration'],
      qualityReasons: ["The previous corpus did not meet the family floor."],
      sharedAnchorTerms: ["document", "retrieval"],
      candidateTitles: [
        "Document retrieval ranking stability evaluation",
        "Ranking stability in document retrieval systems"
      ],
      queryFamilies: []
    });
    const llm = new SequencedJsonLLMClient([
      JSON.stringify({
        shared_anchor: "document retrieval",
        families: [
          { axis: "ranking stability" },
          { axis: "sample efficiency" }
        ],
        assumptions: []
      })
    ]);

    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "ranking stability",
        "sample efficiency"
      ]),
      runContextMemory: memory,
      llm
    });

    expect(llm.prompts).toHaveLength(1);
    expect(result?.queries).toEqual([
      '"document retrieval" ranking stability',
      '"document retrieval" sample efficiency'
    ]);
  });

  it("normalizes derivational variants consistently when candidate titles support an axis", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-title-inflection-"));
    const runId = "run-query-title-inflection";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const memory = new RunContextMemory(contextPath);
    await recordLiteratureQueryPlanRejection(memory, {
      rejectedQueries: ['"document retrieval" uncertainty calibration'],
      qualityReasons: ["The previous corpus did not meet the family floor."],
      sharedAnchorTerms: ["document", "retrieval"],
      candidateTitles: [
        "Estimative uncertainty for document retrieval decisions",
        "Document retrieval with uncertainty estimation"
      ],
      queryFamilies: []
    });
    const llm = new SequencedJsonLLMClient([
      JSON.stringify({
        shared_anchor: "document retrieval",
        families: [
          { axis: "uncertainty estimation" },
          { axis: "sample efficiency" }
        ],
        assumptions: []
      })
    ]);

    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "uncertainty",
        "sample efficiency"
      ]),
      runContextMemory: memory,
      llm
    });

    expect(llm.prompts).toHaveLength(1);
    expect(result?.queries).toEqual([
      '"document retrieval" uncertainty estimation',
      '"document retrieval" sample efficiency'
    ]);
  });

  it("authorizes one capped exploratory portfolio after two title-support-only rejections", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-unsupported-repair-"));
    const runId = "run-query-unsupported-repair";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const memory = new RunContextMemory(contextPath);
    await recordLiteratureQueryPlanRejection(memory, {
      rejectedQueries: ['"document retrieval" uncertainty calibration'],
      qualityReasons: ["The previous corpus did not meet the family floor."],
      sharedAnchorTerms: ["document", "retrieval"],
      candidateTitles: ["Document retrieval ranking overview"],
      queryFamilies: []
    });
    const llm = new SequencedJsonLLMClient([
      JSON.stringify({
        shared_anchor: "document retrieval",
        families: [
          { axis: "paired bootstrap" },
          { axis: "sample efficiency" },
          { axis: "domain transfer" }
        ],
        assumptions: []
      }),
      JSON.stringify({
        shared_anchor: "document retrieval",
        families: [
          { axis: "label shift" },
          { axis: "calibration error" },
          { axis: "annotation variance" }
        ],
        assumptions: []
      })
    ]);

    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "paired bootstrap",
        "sample efficiency",
        "domain transfer",
        "label shift",
        "calibration error",
        "annotation variance"
      ]),
      runContextMemory: memory,
      llm
    });

    expect(result?.source).toBe("llm_bounded_repair");
    expect(result?.queries).toEqual([
      '"document retrieval" label shift',
      '"document retrieval" calibration error'
    ]);
    expect(result?.repairDiagnostic).toMatchObject({
      strategy: "authorize_bounded_unsupported_exploration",
      sourceAttempt: 2,
      selectedFamilyIds: ["topic_family_1", "topic_family_2"],
      finalCorpusGateUnchanged: true
    });
    expect(result?.attemptDiagnostics).toEqual([
      expect.objectContaining({ attempt: 1, status: "rejected_feedback" }),
      expect.objectContaining({ attempt: 2, status: "rejected_feedback" })
    ]);
  });

  it("replans once inside the node when the model repeats rejected families", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-bounded-replan-"));
    const runId = "run-query-bounded-replan";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const memory = new RunContextMemory(contextPath);
    await recordLiteratureQueryPlanRejection(memory, {
      rejectedQueries: [
        '"document retrieval" uncertainty calibration',
        '"document retrieval" distribution shift'
      ],
      qualityReasons: ["The previous corpus did not cover two independent families."],
      sharedAnchorTerms: ["document", "retrieval"],
      queryFamilies: []
    });
    const llm = new SequencedJsonLLMClient([
      JSON.stringify({
        shared_anchor: "document retrieval",
        families: [
          { axis: "uncertainty calibration" },
          { axis: "distribution shift" },
          { axis: "ranking stability" }
        ],
        assumptions: []
      }),
      JSON.stringify({
        shared_anchor: "document retrieval",
        families: [
          { axis: "annotation disagreement" },
          { axis: "ranking variance" },
          { axis: "domain transfer" }
        ],
        assumptions: []
      })
    ]);

    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "uncertainty calibration",
        "distribution shift",
        "ranking stability",
        "annotation disagreement",
        "ranking variance",
        "domain transfer"
      ]),
      runContextMemory: memory,
      llm
    });

    expect(llm.prompts).toHaveLength(2);
    expect(llm.prompts[1]).toContain("literature_query_plan_reuses_rejected_families");
    expect(result?.queries).toEqual([
      '"document retrieval" annotation disagreement',
      '"document retrieval" ranking variance',
      '"document retrieval" domain transfer'
    ]);
  });

  it("compares topic-discovery families by their axes instead of their shared anchor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-axis-family-"));
    const runId = "run-query-axis-family";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");

    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "confidence calibration under label shift",
        "confidence stability under finite samples"
      ], "document retrieval evaluation"),
      runContextMemory: new RunContextMemory(contextPath),
      llm: new SequencedJsonLLMClient([
        JSON.stringify({
          shared_anchor: "document retrieval evaluation",
          families: [
            { axis: "confidence calibration" },
            { axis: "confidence stability" }
          ],
          assumptions: []
        })
      ])
    });

    expect(result?.queries).toEqual([
      '"document retrieval evaluation" confidence calibration',
      '"document retrieval evaluation" confidence stability'
    ]);
    expect(result?.topicDiscoveryPlan?.families).toHaveLength(2);
    expect(result?.topicDiscoveryPlan).toMatchObject({
      version: 4,
      termNormalizationVersion: TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION,
      candidateRecallSemanticsVersion: TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
      families: expect.arrayContaining([
        expect.objectContaining({
          lens: expect.any(String),
          contributionIntent: "measurement",
          contractSource: "bounded_inference"
        })
      ])
    });
  });

  it("does not revive a cached topic plan from v3 query semantics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-cache-version-"));
    const runId = "run-query-cache-version";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const memory = new RunContextMemory(contextPath);
    const rawBrief = buildScopedTopicDiscoveryBrief([
      "confidence calibration under label shift",
      "distribution shift under external populations",
      "ranking stability under finite samples",
      "annotation variance across judges"
    ]);
    const firstLlm = new SequencedJsonLLMClient([
      JSON.stringify({
        shared_anchor: "document retrieval",
        families: [
          { axis: "confidence calibration" },
          { axis: "distribution shift" }
        ],
        assumptions: []
      })
    ]);
    await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief,
      runContextMemory: memory,
      llm: firstLlm,
      plannerIdentity: "fixture:model-a"
    });
    const staleCache = await memory.get<Record<string, unknown>>(
      "collect_papers.llm_query_plan"
    );
    expect(staleCache).toBeDefined();
    staleCache!.version = 3;
    await memory.put("collect_papers.llm_query_plan", staleCache);

    const secondLlm = new SequencedJsonLLMClient([
      JSON.stringify({
        shared_anchor: "document retrieval",
        families: [
          { axis: "ranking stability" },
          { axis: "annotation variance" }
        ],
        assumptions: []
      })
    ]);
    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief,
      runContextMemory: memory,
      llm: secondLlm,
      plannerIdentity: "fixture:model-a"
    });

    expect(secondLlm.prompts).toHaveLength(1);
    expect(result?.queries).toEqual([
      '"document retrieval" ranking stability',
      '"document retrieval" annotation variance'
    ]);
  });

  it("deduplicates finite-sample surface variants before counting independent families", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-context-family-"));
    const runId = "run-query-context-family";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");

    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "finite sample uncertainty in comparative rankings",
        "distribution shift across evaluation populations"
      ], "document retrieval evaluation"),
      runContextMemory: new RunContextMemory(contextPath),
      llm: new SequencedJsonLLMClient([
        JSON.stringify({
          shared_anchor: "document retrieval evaluation",
          families: [
            { axis: "finite sample uncertainty" },
            { axis: "limited sample uncertainty" },
            { axis: "distribution shift" }
          ],
          assumptions: []
        })
      ])
    });

    expect(result?.queries).toEqual([
      '"document retrieval evaluation" finite sample uncertainty',
      '"document retrieval evaluation" distribution shift'
    ]);
    expect(result?.topicDiscoveryPlan?.families).toHaveLength(2);
  });

  it("preserves distinct research axes when one canonical axis contains the other", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-distinct-axis-"));
    const runId = "run-query-distinct-axis";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");

    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "ranking stability",
        "ranking stability intervention"
      ], "document retrieval evaluation"),
      runContextMemory: new RunContextMemory(contextPath),
      llm: new SequencedJsonLLMClient([
        JSON.stringify({
          shared_anchor: "document retrieval evaluation",
          families: [
            { axis: "ranking stability" },
            { axis: "ranking stability intervention" }
          ],
          assumptions: []
        })
      ])
    });

    expect(result?.queries).toEqual([
      '"document retrieval evaluation" ranking stability',
      '"document retrieval evaluation" ranking stability intervention'
    ]);
    expect(result?.topicDiscoveryPlan?.families).toHaveLength(2);
  });

  it("quarantines v4 rejection feedback under the v5 feedback contract", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-feedback-version-"));
    const runId = "run-query-feedback-version";
    const memoryDir = path.join(root, ".autolabos", "runs", runId, "memory");
    await mkdir(memoryDir, { recursive: true });
    const contextPath = path.join(memoryDir, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const memory = new RunContextMemory(contextPath);
    await memory.put("collect_papers.llm_query_plan_feedback", {
      version: 4,
      rejectedQueries: ["obsolete artifact axis"],
      qualityReasons: ["zero candidates in an older recall contract"],
      sharedAnchorTerms: ["document", "retrieval"],
      candidateTitles: ["Obsolete artifact title"],
      queryFamilies: [],
      supportedQueryFamilies: [],
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
    const llm = new SequencedJsonLLMClient([
      JSON.stringify({
        shared_anchor: "document retrieval",
        families: [
          { axis: "confidence calibration" },
          { axis: "distribution shift" }
        ],
        assumptions: []
      })
    ]);

    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "confidence calibration under label shift",
        "distribution shift under external populations"
      ]),
      runContextMemory: memory,
      llm
    });

    expect(llm.prompts).toHaveLength(1);
    expect(llm.prompts[0]).not.toContain("obsolete artifact axis");
    expect(result?.queries).toEqual([
      '"document retrieval" confidence calibration',
      '"document retrieval" distribution shift'
    ]);
  });

  it("rebuilds a tampered persisted scope contract from the current brief", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-scope-tamper-"));
    const runId = "run-query-scope-tamper";
    const contextPath = path.join(root, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const memory = new RunContextMemory(contextPath);
    const rawBrief = buildScopedTopicDiscoveryBrief([
      "ranking stability under finite samples",
      "annotation disagreement across judges"
    ]);
    const first = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief,
      runContextMemory: memory,
      llm: new SequencedJsonLLMClient([
        JSON.stringify({
          shared_anchor: "document retrieval",
          families: [
            { axis: "ranking stability" },
            { axis: "annotation disagreement" }
          ],
          assumptions: []
        })
      ]),
      plannerIdentity: "fixture:scope-tamper"
    });
    const stored = await memory.get<any>("collect_papers.topic_discovery_scope_contract");
    stored.axes[0].sourceTerms = ["tampered", "axis"];
    await memory.put("collect_papers.topic_discovery_scope_contract", stored);
    const cachedLlm = new SequencedJsonLLMClient([]);

    await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief,
      runContextMemory: memory,
      llm: cachedLlm,
      plannerIdentity: "fixture:scope-tamper"
    });

    const rebuilt = await memory.get<any>("collect_papers.topic_discovery_scope_contract");
    expect(cachedLlm.prompts).toHaveLength(0);
    expect(rebuilt.axes).toEqual(first?.scientificScopeContract?.axes);
    expect(JSON.stringify(rebuilt.axes)).not.toContain("tampered");
  });

  it("does not let a structurally invalid retry replace an executed shared anchor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-structural-anchor-"));
    const runId = "run-query-structural-anchor";
    const contextPath = path.join(root, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const memory = new RunContextMemory(contextPath);
    await recordLiteratureQueryPlanRejection(memory, {
      rejectedQueries: ['"document retrieval" prior uncertainty'],
      qualityReasons: ["The prior family remained unsupported."],
      sharedAnchorTerms: ["document", "retrieval"],
      candidateTitles: [],
      queryFamilies: []
    });
    const llm = new SequencedJsonLLMClient([
      JSON.stringify({
        shared_anchor: "retrieval systems",
        families: [{ axis: "ranking stability" }],
        assumptions: []
      }),
      JSON.stringify({
        shared_anchor: "document retrieval",
        families: [
          { axis: "ranking stability" },
          { axis: "annotation disagreement" }
        ],
        assumptions: []
      })
    ]);

    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "ranking stability",
        "annotation disagreement"
      ]),
      runContextMemory: memory,
      llm
    });

    expect(llm.prompts).toHaveLength(2);
    expect(llm.prompts[1]).toContain(
      "The executed shared anchor is immutable for this recovery generation: return exactly document retrieval."
    );
    expect(result?.queries).toEqual([
      '"document retrieval" ranking stability',
      '"document retrieval" annotation disagreement'
    ]);
  });

  it("fails closed when recovery has no enforceable brief scope", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-empty-recovery-scope-"));
    const runId = "run-query-empty-recovery-scope";
    const contextPath = path.join(root, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const memory = new RunContextMemory(contextPath);
    await recordLiteratureQueryPlanRejection(memory, {
      rejectedQueries: ['"document retrieval" prior uncertainty'],
      qualityReasons: ["The prior family remained unsupported."],
      sharedAnchorTerms: ["document", "retrieval"],
      candidateTitles: [],
      queryFamilies: []
    });
    const response = JSON.stringify({
      shared_anchor: "document retrieval",
      families: [
        { axis: "ranking stability" },
        { axis: "annotation disagreement" }
      ],
      assumptions: []
    });

    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: "# Research Brief\n\n## Research Mode\ntopic_discovery\n\n## Topic\nDocument retrieval",
      runContextMemory: memory,
      llm: new SequencedJsonLLMClient([response, response])
    });

    expect(result).toMatchObject({
      source: "deterministic_fallback",
      queries: [],
      scientificScopeDiagnostic: {
        status: "insufficient_brief_source_material",
        recovery: true
      }
    });
    expect(result?.repairDiagnostic).toBeUndefined();
    expect(result?.failureReason).toContain("scope_contract_unavailable");
  });

  it("does not let title support or bounded repair authorize an out-of-scope family", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-scope-bypass-"));
    const runId = "run-query-scope-bypass";
    const contextPath = path.join(root, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const memory = new RunContextMemory(contextPath);
    await recordLiteratureQueryPlanRejection(memory, {
      rejectedQueries: ['"document retrieval" prior uncertainty'],
      qualityReasons: ["The prior family remained unsupported."],
      sharedAnchorTerms: ["document", "retrieval"],
      candidateTitles: [
        "Adjacent mitigation for document retrieval",
        "Document retrieval with adjacent mitigation",
        "Proxy grading for document retrieval",
        "Document retrieval proxy grading study"
      ],
      queryFamilies: []
    });
    const llm = new SequencedJsonLLMClient([
      JSON.stringify({
        shared_anchor: "document retrieval",
        families: [
          { axis: "adjacent mitigation" },
          { axis: "proxy grading" }
        ],
        assumptions: []
      }),
      JSON.stringify({
        shared_anchor: "document retrieval",
        families: [
          { axis: "latent routing" },
          { axis: "evidence compression" }
        ],
        assumptions: []
      })
    ]);

    const result = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "ranking stability",
        "annotation disagreement"
      ]),
      runContextMemory: memory,
      llm
    });

    expect(llm.prompts).toHaveLength(2);
    expect(result?.source).toBe("deterministic_fallback");
    expect(result?.queries).toEqual([]);
    expect(result?.repairDiagnostic).toBeUndefined();
    expect(result?.failureReason).toContain("literature_query_plan_scientific_scope_rejected:");
  });

  it("quarantines prior feedback when the brief scope fingerprint changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autolabos-query-scope-refresh-"));
    const runId = "run-query-scope-refresh";
    const contextPath = path.join(root, "run_context.json");
    await writeFile(contextPath, JSON.stringify({ version: 1, items: [] }), "utf8");
    const memory = new RunContextMemory(contextPath);
    const firstBrief = buildScopedTopicDiscoveryBrief([
      "ranking stability",
      "annotation disagreement"
    ]);
    const first = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: firstBrief,
      runContextMemory: memory,
      llm: new SequencedJsonLLMClient([
        JSON.stringify({
          shared_anchor: "document retrieval",
          families: [
            { axis: "ranking stability" },
            { axis: "annotation disagreement" }
          ],
          assumptions: []
        })
      ])
    });
    await recordLiteratureQueryPlanRejection(memory, {
      rejectedQueries: first?.queries ?? [],
      qualityReasons: ["The first scope did not meet its evidence floor."],
      sharedAnchorTerms: ["document", "retrieval"],
      candidateTitles: ["Old scope ranking stability"],
      queryFamilies: [],
      scientificScopeFingerprint: first?.scientificScopeContract?.scopeFingerprint
    });
    const secondLlm = new SequencedJsonLLMClient([
      JSON.stringify({
        shared_anchor: "document retrieval",
        families: [
          { axis: "calibration drift" },
          { axis: "label uncertainty" }
        ],
        assumptions: []
      })
    ]);
    const second = await resolveGeneratedLiteratureQueries({
      run: buildRun(runId),
      rawBrief: buildScopedTopicDiscoveryBrief([
        "calibration drift",
        "label uncertainty"
      ]),
      runContextMemory: memory,
      llm: secondLlm
    });

    expect(secondLlm.prompts).toHaveLength(1);
    expect(secondLlm.prompts[0]).not.toContain("Previous retrieval-plan rejection:");
    expect(secondLlm.prompts[0]).not.toContain("Old scope ranking stability");
    expect(second?.scientificScopeContract?.scopeFingerprint)
      .not.toBe(first?.scientificScopeContract?.scopeFingerprint);
    expect(second?.queries).toEqual([
      '"document retrieval" calibration drift',
      '"document retrieval" label uncertainty'
    ]);
  });
});
