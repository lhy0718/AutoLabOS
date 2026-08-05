import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryEventStream } from "../src/core/events.js";
import { MockLLMClient } from "../src/core/llm/client.js";
import {
  createCollectPapersNode,
  waitForAllCollectEnrichmentJobs
} from "../src/core/nodes/collectPapers.js";
import {
  isCurrentTopicDiscoveryCollectQueryPlanArtifact,
  TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT
} from "../src/core/collection/topicDiscoveryArtifactVersions.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import type { RunRecord } from "../src/types.js";
import { RunContextMemory } from "../src/core/memory/runContextMemory.js";
import {
  buildCandidatePriorSearchPlan,
  validateCandidatePriorSearchReceipt
} from "../src/core/candidatePriorSearch.js";
import { buildPriorAbsorptionCandidateContract } from "../src/core/priorAbsorption.js";
import { TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION } from "../src/core/topicDiscoveryScientificTerms.js";
import type { HypothesisCandidate } from "../src/core/analysis/researchPlanning.js";
import { createHash } from "node:crypto";

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_CONSTRAINT_TIMEOUT = process.env.AUTOLABOS_CONSTRAINT_PROFILE_TIMEOUT_MS;
const ORIGINAL_QUERY_TIMEOUT = process.env.AUTOLABOS_LITERATURE_QUERY_TIMEOUT_MS;
const DOMAIN_TOPIC =
  "document retrieval, confidence calibration, and limited annotation budgets";
const BRIEF_TOPIC =
  "Search for a workshop-scale empirical question at the intersection of document retrieval, confidence calibration under limited annotation budgets, and reproducible local execution. Exclude proprietary corpora and paid services.";

class HangingLLMClient extends MockLLMClient {
  override async complete(): Promise<{ text: string }> {
    return await new Promise<{ text: string }>(() => {});
  }
}

class JsonLLMClient extends MockLLMClient {
  constructor(private readonly response: string) {
    super();
  }

  override async complete(prompt: string): Promise<{ text: string }> {
    return { text: semanticAuditFixtureResponse(prompt) ?? this.response };
  }
}

class CapturingJsonLLMClient extends JsonLLMClient {
  readonly prompts: string[] = [];

  override async complete(prompt: string): Promise<{ text: string }> {
    this.prompts.push(prompt);
    return super.complete(prompt);
  }
}

function semanticAuditFixtureResponse(prompt: string): string | undefined {
  const marker = "\nInput:\n";
  if (!prompt.startsWith("Conservatively triage every requested paper-family pair.")) {
    return undefined;
  }
  const markerIndex = prompt.lastIndexOf(marker);
  if (markerIndex < 0) {
    return JSON.stringify({ judgments: [] });
  }
  const payload = JSON.parse(prompt.slice(markerIndex + marker.length)) as {
    papers: Array<{ paper_id: string; title: string }>;
    requested_pairs: Array<{
      paper_id: string;
      family_id: string;
      selection_source: "lexical_match" | "provider_provenance_floor";
    }>;
  };
  const titleByPaper = new Map(
    payload.papers.map((paper) => [paper.paper_id, paper.title] as const)
  );
  return JSON.stringify({
    judgments: payload.requested_pairs.map((pair) => ({
      paper_id: pair.paper_id,
      family_id: pair.family_id,
      verdict: pair.selection_source === "lexical_match"
        ? "direct_support"
        : "application_only",
      reason: pair.selection_source === "lexical_match"
        ? "The supplied title directly satisfies the family contract."
        : "Provider provenance alone does not establish direct family support.",
      ...(pair.selection_source === "lexical_match"
        ? { evidence_span: titleByPaper.get(pair.paper_id) ?? "" }
        : {})
    }))
  });
}

interface TopicDiscoveryFixture {
  runDir: string;
  run: RunRecord;
}

interface ObservedSearchRequest {
  query: string;
  limit: number;
  sort?: {
    field?: string;
    order?: string;
  };
  filters?: {
    fieldsOfStudy?: string[];
    publicationDateOrYear?: string;
  };
}

interface SearchPaperFixture {
  paperId: string;
  title: string;
  abstract: string;
  authors: string[];
  year?: number;
  doi?: string;
  arxivId?: string;
}

interface CollectQueryAttemptFixture {
  query?: string;
  queryFamily?: string;
  retrievalLane?: string;
  source?: string;
  sourceReason?: string;
  allocatedLimit?: number;
  retrievalLimit?: number;
  relevantFetched?: number;
  selected?: number;
  providerDiagnostics?: Array<{
    provider?: string;
    query?: string;
    fetched?: number;
  }>;
}

interface CollectCorpusQualityFixture {
  passed?: boolean;
  reasons?: unknown;
  observed?: {
    relevant_papers?: unknown;
    relevant_share?: unknown;
    covered_query_families?: unknown;
  };
}

async function createTopicDiscoveryFixture(
  runId: string,
  limit: number,
  requestOverrides: Record<string, unknown> = {}
): Promise<TopicDiscoveryFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "autolabos-topic-portfolio-"));
  process.chdir(root);
  const now = new Date().toISOString();
  const run: RunRecord = {
    version: 3,
    workflowVersion: 3,
    id: runId,
    title: "Bounded Topic Portfolio",
    topic: DOMAIN_TOPIC,
    constraints: [],
    objectiveMetric: "candidate evidence coverage",
    status: "running",
    currentNode: "collect_papers",
    latestSummary: undefined,
    nodeThreads: {},
    createdAt: now,
    updatedAt: now,
    graph: createDefaultGraphState(),
    memoryRefs: {
      runContextPath: `.autolabos/runs/${runId}/memory/run_context.json`,
      longTermPath: `.autolabos/runs/${runId}/memory/long_term.jsonl`,
      episodePath: `.autolabos/runs/${runId}/memory/episodes.jsonl`
    }
  };
  const runDir = path.join(root, ".autolabos", "runs", runId);
  const memoryDir = path.join(runDir, "memory");
  await mkdir(memoryDir, { recursive: true });
  await writeFile(
    path.join(memoryDir, "run_context.json"),
    JSON.stringify({
      version: 1,
      items: [
        {
          key: "run_brief.raw",
          value: [
            "# Research Brief",
            "",
            "## Research Mode",
            "",
            "topic_discovery",
            "",
            "## Topic",
            "",
            BRIEF_TOPIC,
            "",
            "## Scientific Scope",
            "### Scientific Object",
            "- document retrieval evaluation",
            "",
            "### Empirical Problems",
            "- confidence calibration under limited labels",
            "- distribution shift across query populations",
            "- ranking stability under annotation disagreement",
            "",
            "### Prior-Work Probes",
            "- whether direct prior work already subsumes the declared problems",
            "",
            "## Research Question",
            "",
            "How do confidence calibration, distribution shift, and ranking stability affect document retrieval conclusions under limited annotations?"
          ].join("\n"),
          updatedAt: now
        },
        {
          key: "collect_papers.request",
          value: {
            limit,
            bibtexMode: "generated",
            ...requestOverrides
          },
          updatedAt: now
        }
      ]
    }),
    "utf8"
  );
  return { runDir, run };
}

function createSearchHarness(
  makePapers: (request: ObservedSearchRequest, familyIndex: number) => SearchPaperFixture[]
) {
  const observedRequests: ObservedSearchRequest[] = [];
  const streamSearchPapers = vi.fn(async function* (request: ObservedSearchRequest) {
    const familyIndex = observedRequests.length;
    observedRequests.push({
      query: request.query,
      limit: request.limit,
      sort: request.sort,
      filters: request.filters
    });
    yield makePapers(request, familyIndex);
  });
  return { observedRequests, streamSearchPapers };
}

function createTestNode(input: {
  maxResults: number;
  llm: MockLLMClient;
  eventStream: InMemoryEventStream;
  streamSearchPapers: ReturnType<typeof vi.fn>;
}) {
  return createCollectPapersNode({
    config: {
      papers: { max_results: input.maxResults },
      providers: { llm_mode: "ollama" }
    } as any,
    runStore: {} as any,
    eventStream: input.eventStream,
    llm: input.llm,
    codex: {} as any,
    aci: {} as any,
    semanticScholar: {
      streamSearchPapers: input.streamSearchPapers,
      getLastSearchDiagnostics: vi.fn(() => ({
        attemptCount: 1,
        lastStatus: 200,
        attempts: [{ attempt: 1, ok: true, status: 200, endpoint: "search" }]
      }))
    } as any
  });
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

afterEach(async () => {
  await waitForAllCollectEnrichmentJobs();
  process.chdir(ORIGINAL_CWD);
  if (ORIGINAL_CONSTRAINT_TIMEOUT === undefined) {
    delete process.env.AUTOLABOS_CONSTRAINT_PROFILE_TIMEOUT_MS;
  } else {
    process.env.AUTOLABOS_CONSTRAINT_PROFILE_TIMEOUT_MS = ORIGINAL_CONSTRAINT_TIMEOUT;
  }
  if (ORIGINAL_QUERY_TIMEOUT === undefined) {
    delete process.env.AUTOLABOS_LITERATURE_QUERY_TIMEOUT_MS;
  } else {
    process.env.AUTOLABOS_LITERATURE_QUERY_TIMEOUT_MS = ORIGINAL_QUERY_TIMEOUT;
  }
});

describe("topic-discovery deterministic collection portfolio", () => {
  it("executes every candidate-prior lane and writes a monotonic corpus receipt", async () => {
    const { run, runDir } = await createTopicDiscoveryFixture(
      "run-candidate-prior-portfolio",
      2
    );
    run.graph.researchCycle = 1;
    const sourceAttemptId = "collect-attempt-candidate-prior-source";
    const sourceRow = {
      paper_id: "paper_source",
      title: "Source reference",
      abstract: "An existing source retained across bounded collection.",
      authors: ["Fixture Author"],
      query_families: ["family_original"]
    };
    const sourceCorpusRaw = `${JSON.stringify(sourceRow)}\n`;
    await writeFile(path.join(runDir, "corpus.jsonl"), sourceCorpusRaw, "utf8");
    await writeFile(
      path.join(runDir, "collect_generation.json"),
      JSON.stringify({
        version: 1,
        kind: "collect_generation",
        run_id: run.id,
        collect_attempt_id: sourceAttemptId,
        started_at: "2026-07-28T08:00:00.000Z"
      }),
      "utf8"
    );
    const candidate: HypothesisCandidate = {
      id: "candidate_prior_fixture",
      text: "Typed provenance tests a falsifiable relation over structured records.",
      novelty: 0.7,
      feasibility: 0.8,
      testability: 0.9,
      cost: 0.3,
      expected_gain: 0.2,
      evidence_links: ["evidence_reference"],
      contribution_claim: "Improved support for findings over structured records.",
      dataset_task_bench: "held out structured records",
      comparator: "post hoc verification",
      primary_metric: "supported finding rate",
      meaningful_effect: "a prespecified reduction in unsupported findings",
      minimum_publishable_evidence: "bounded repeated comparisons",
      falsifier: "no measurable change in unsupported findings"
    };
    const plan = buildCandidatePriorSearchPlan({
      runId: run.id,
      researchCycle: 0,
      generatedAt: "2026-07-28T08:30:00.000Z",
      asOfDate: "2026-07-28",
      sourceCorpus: {
        collect_attempt_id: sourceAttemptId,
        sha256: createHash("sha256")
          .update(sourceCorpusRaw, "utf8")
          .digest("hex"),
        byte_length: Buffer.byteLength(sourceCorpusRaw, "utf8")
      },
      candidates: [{
        candidate,
        candidateContract: buildPriorAbsorptionCandidateContract(candidate)
      }]
    });
    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    await runContext.put("collect_papers.request", {
      additional: 2,
      bibtexMode: "generated",
      candidatePriorSearchPlan: plan
    });
    const { observedRequests, streamSearchPapers } = createSearchHarness(
      (request, familyIndex) => [{
        paperId: `paper_candidate_${familyIndex + 1}`,
        title: `${request.query} direct prior ${familyIndex + 1}`,
        abstract: "A direct comparison matching the requested candidate contract.",
        authors: ["Fixture Author"]
      }]
    );
    const node = createTestNode({
      maxResults: 2,
      eventStream: new InMemoryEventStream(),
      streamSearchPapers,
      llm: new JsonLLMClient("{}")
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    expect(observedRequests).toHaveLength(6);
    expect(new Set(observedRequests.map((request) => request.sort?.field))).toEqual(
      new Set(["relevance", "publicationDate"])
    );
    const queryPlan = await readJson<{
      collect_attempt_id?: string;
      strategy?: string;
      selected_families?: Array<{
        query_family?: string;
        retrieval_lane?: string;
        source?: string;
      }>;
    }>(path.join(runDir, "collect_query_plan.json"));
    expect(queryPlan.strategy).toBe("candidate_prior_portfolio");
    expect(queryPlan.selected_families).toHaveLength(6);
    expect(queryPlan.selected_families?.every(
      (family) => family.source === "candidate_prior_plan"
    )).toBe(true);
    expect(new Set(queryPlan.selected_families?.map(
      (family) => family.retrieval_lane
    ))).toEqual(new Set(["broad_relevance", "recent_direct_prior"]));
    const resultCorpusRaw = await readFile(path.join(runDir, "corpus.jsonl"), "utf8");
    const resultRows = resultCorpusRaw.trim().split("\n").map((line) => JSON.parse(line));
    expect(resultRows.find((row) => row.paper_id === sourceRow.paper_id)).toEqual(sourceRow);
    const plannedFamilyIds = new Set(
      plan.candidates[0].families.map((family) => family.family_id)
    );
    expect(resultRows
      .filter((row) => row.paper_id !== sourceRow.paper_id)
      .every((row) => row.query_families.some(
        (familyId: string) => plannedFamilyIds.has(familyId)
      ))).toBe(true);
    const receipt = await readJson<Record<string, unknown>>(
      path.join(runDir, "collect_candidate_prior_search_receipt.json")
    );
    expect(validateCandidatePriorSearchReceipt(receipt, {
      plan,
      expectedCollectAttemptId: queryPlan.collect_attempt_id || "",
      sourceCorpusRaw,
      resultCorpusRaw
    })).toMatchObject({ valid: true, reasons: [] });

    await runContext.put("collect_papers.request", {
      additional: 2,
      candidatePriorSearchPlan: plan
    });
    const requestCountBeforeStaleRetry = observedRequests.length;
    const staleRetry = await node.execute({ run, graph: run.graph });
    expect(staleRetry.status).toBe("failure");
    expect(staleRetry.error).toContain(
      "candidate_prior_search_source_attempt_mismatch"
    );
    expect(staleRetry.error).toContain(
      "candidate_prior_search_source_corpus_mismatch"
    );
    expect(observedRequests).toHaveLength(requestCountBeforeStaleRetry);
  });

  it("deduplicates structured families and emits an analyze-compatible query-plan contract", async () => {
    const { run, runDir } = await createTopicDiscoveryFixture(
      "run-topic-near-duplicate-plan",
      8
    );
    const { observedRequests, streamSearchPapers } = createSearchHarness(
      (request, familyIndex) =>
        Array.from({ length: request.limit }, (_, paperIndex) => ({
          paperId: `relevant-family-${familyIndex}-paper-${paperIndex}`,
          title: request.query.includes("distribution shift")
            ? `Document retrieval evaluation under distribution shift ${familyIndex}-${paperIndex}`
            : `Document retrieval evaluation with confidence calibration ${familyIndex}-${paperIndex}`,
          abstract:
            "The study evaluates document retrieval with the named measurement axis under controlled evidence.",
          authors: ["Fixture Author"]
        }))
    );
    const node = createTestNode({
      maxResults: 8,
      eventStream: new InMemoryEventStream(),
      streamSearchPapers,
      llm: new JsonLLMClient(
        JSON.stringify({
          shared_anchor: "document retrieval evaluation",
          families: [
            { id: "calibration", axis: "confidence calibration" },
            { id: "calibration-duplicate", axis: "confidence calibration" },
            { id: "shift", axis: "distribution shift" }
          ],
          assumptions: []
        })
      )
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    expect(result.needsApproval).toBe(true);
    expect(observedRequests).toHaveLength(4);

    const collectResult = await readJson<{
      queryAttempts?: CollectQueryAttemptFixture[];
    }>(path.join(runDir, "collect_result.json"));
    const attempts = collectResult.queryAttempts ?? [];
    expect(attempts).toHaveLength(observedRequests.length);
    expect(attempts.every((attempt) => attempt.source === "llm_query_planner")).toBe(true);

    const queryFamilies = attempts.map((attempt) => attempt.queryFamily?.trim() ?? "");
    expect(queryFamilies.every(Boolean)).toBe(true);
    expect(new Set(queryFamilies).size).toBe(2);
    expect(new Set(attempts.map((attempt) => attempt.retrievalLane))).toEqual(
      new Set(["recent_direct_prior", "broad_relevance"])
    );
    for (const family of new Set(queryFamilies)) {
      expect(
        attempts
          .filter((attempt) => attempt.queryFamily === family)
          .map((attempt) => attempt.retrievalLane)
          .sort()
      ).toEqual(["broad_relevance", "recent_direct_prior"]);
    }
    const expectedYear = new Date(run.createdAt).getUTCFullYear();
    const recentRequests = observedRequests.filter(
      (request) => request.sort?.field === "publicationDate"
    );
    expect(recentRequests).toHaveLength(2);
    expect(recentRequests.every(
      (request) =>
        request.sort?.order === "desc"
        && request.filters?.publicationDateOrYear
          ?.startsWith(`${expectedYear - 1}-01-01:${expectedYear}-`)
    )).toBe(true);
    expect(observedRequests.filter(
      (request) => request.sort?.field === "relevance"
    )).toHaveLength(2);
    expect(attempts.map((attempt) => attempt.query)).toEqual(
      observedRequests.map((request) => request.query)
    );
    expect(
      attempts.every(
        (attempt) =>
          attempt.providerDiagnostics?.length === 1 &&
          attempt.providerDiagnostics[0]?.provider === "semantic_scholar" &&
          attempt.providerDiagnostics[0]?.query === attempt.query
      )
    ).toBe(true);

    const queryPlan = await readJson<{
      version?: number;
      planning_timeout_policy?: {
        llm_mode?: string;
        constraint_profile_timeout_ms?: number;
        literature_query_timeout_ms?: number;
      };
      planner?: {
        scientific_scope_contract?: {
          version?: number;
          briefFingerprint?: string;
          scopeFingerprint?: string;
          contractFingerprint?: string;
        };
        scientific_scope_diagnostic?: {
          enforced?: boolean;
          status?: string;
          sourceSections?: string[];
        };
      };
    }>(
      path.join(runDir, "collect_query_plan.json")
    );
    expect(queryPlan).toMatchObject(TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT);
    expect(isCurrentTopicDiscoveryCollectQueryPlanArtifact(queryPlan)).toBe(true);
    expect(queryPlan.planning_timeout_policy).toMatchObject({
      llm_mode: "ollama",
      constraint_profile_timeout_ms: 180_000,
      literature_query_timeout_ms: 180_000
    });
    expect(queryPlan.planner?.scientific_scope_contract).toMatchObject({
      version: 3,
      termNormalizationVersion: TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION,
      briefFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      scopeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      contractFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(queryPlan.planner?.scientific_scope_diagnostic).toMatchObject({
      enforced: true,
      status: "passed",
      sourceSections: ["scientific_scope"]
    });
    const corpusRows = (await readFile(path.join(runDir, "corpus.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { query_families?: string[] });
    expect(corpusRows.every((row) => (row.query_families?.length ?? 0) > 0)).toBe(true);
    expect(new Set(corpusRows.flatMap((row) => row.query_families ?? [])).size).toBeGreaterThanOrEqual(2);
    const corpusQuality = await readJson<{
      query_families?: Array<{ query_family?: string; relevant_paper_count?: number }>;
    }>(path.join(runDir, "collect_corpus_quality.json"));
    for (const family of corpusQuality.query_families ?? []) {
      expect(
        corpusRows.filter((row) => row.query_families?.includes(family.query_family ?? "")).length
      ).toBe(family.relevant_paper_count);
    }
  });

  it("counts one work once when preprint and published records arrive in separate lanes", async () => {
    const { run, runDir } = await createTopicDiscoveryFixture(
      "run-topic-cross-lane-work-deduplication",
      8
    );
    const duplicateTitle =
      "Document retrieval evaluation with confidence calibration across editions";
    const { streamSearchPapers } = createSearchHarness(
      (request, familyIndex) =>
        Array.from({ length: 4 }, (_, paperIndex) => {
          const isCalibration = request.query.includes("confidence calibration");
          if (isCalibration && paperIndex === 0) {
            return {
              paperId: familyIndex === 0
                ? "preprint-provider-id"
                : "published-provider-id",
              title: duplicateTitle,
              abstract:
                "Document retrieval evaluation measures confidence calibration under controlled evidence.",
              authors: ["Fixture Author"],
              year: familyIndex === 0 ? 2025 : 2026
            };
          }
          return {
            paperId: `cross-lane-${familyIndex}-${paperIndex}`,
            title: isCalibration
              ? `Document retrieval evaluation confidence calibration ${familyIndex}-${paperIndex}`
              : `Document retrieval evaluation distribution shift ${familyIndex}-${paperIndex}`,
            abstract:
              "The study evaluates document retrieval with the named measurement axis under controlled evidence.",
            authors: ["Fixture Author"]
          };
        })
    );
    const node = createTestNode({
      maxResults: 8,
      eventStream: new InMemoryEventStream(),
      streamSearchPapers,
      llm: new JsonLLMClient(JSON.stringify({
        shared_anchor: "document retrieval evaluation",
        families: [
          { id: "calibration", axis: "confidence calibration" },
          { id: "shift", axis: "distribution shift" }
        ],
        assumptions: []
      }))
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    const semanticInput = await readJson<{
      payload?: { papers?: Array<{ paper_id?: string; title?: string }> };
    }>(path.join(runDir, "collect_semantic_review_input.json"));
    expect(semanticInput.payload?.papers?.filter(
      (paper) => paper.title === duplicateTitle
    )).toHaveLength(1);
    const sidecarRows = (await readFile(
      path.join(runDir, "collect_topic_discovery_candidates.jsonl"),
      "utf8"
    )).trim().split("\n").map((line) => JSON.parse(line) as {
      paper_id?: string;
      title?: string;
      query_families?: string[];
    });
    const duplicateRows = sidecarRows.filter((row) => row.title === duplicateTitle);
    expect(duplicateRows).toHaveLength(1);
    expect(duplicateRows[0]?.query_families).toHaveLength(1);
  });

  it("suppresses provider-taxonomy fields during cross-provider topic discovery and records the policy", async () => {
    const { run, runDir } = await createTopicDiscoveryFixture(
      "run-topic-portable-filter-policy",
      8,
      { filters: { fieldsOfStudy: ["Computer Science"] } }
    );
    const { observedRequests, streamSearchPapers } = createSearchHarness(
      (request, familyIndex) =>
        Array.from({ length: 4 }, (_, paperIndex) => ({
          paperId: `portable-filter-${familyIndex}-${paperIndex}`,
          title: request.query.includes("distribution shift")
            ? `Document retrieval evaluation distribution shift ${familyIndex}-${paperIndex}`
            : `Document retrieval evaluation confidence calibration ${familyIndex}-${paperIndex}`,
          abstract: "A controlled document retrieval evaluation reports the named scientific axis.",
          authors: ["Fixture Author"]
        }))
    );
    const node = createTestNode({
      maxResults: 8,
      eventStream: new InMemoryEventStream(),
      streamSearchPapers,
      llm: new JsonLLMClient(
        JSON.stringify({
          shared_anchor: "document retrieval evaluation",
          families: [
            { axis: "confidence calibration" },
            { axis: "distribution shift" }
          ],
          assumptions: []
        })
      )
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    expect(observedRequests).toHaveLength(4);
    expect(observedRequests.every((request) => !request.filters?.fieldsOfStudy?.length)).toBe(true);
    const queryPlan = await readJson<{
      filter_policy?: {
        applied?: { fieldsOfStudy?: string[] };
        suppressed?: Array<{ filter?: string; values?: string[]; reason?: string }>;
      };
    }>(path.join(runDir, "collect_query_plan.json"));
    expect(queryPlan.filter_policy?.applied?.fieldsOfStudy).toBeUndefined();
    expect(queryPlan.filter_policy?.suppressed).toEqual([
      {
        filter: "fieldsOfStudy",
        values: ["Computer Science"],
        reason: "topic_discovery_cross_provider_taxonomy_mismatch"
      }
    ]);
  });

  it("fails topic discovery when a large provider corpus misses every domain anchor", async () => {
    process.env.AUTOLABOS_CONSTRAINT_PROFILE_TIMEOUT_MS = "5";
    process.env.AUTOLABOS_LITERATURE_QUERY_TIMEOUT_MS = "5";

    const { run, runDir } = await createTopicDiscoveryFixture(
      "run-topic-off-domain-corpus",
      8
    );
    const unrelatedTitles = [
      "Seasonal shoreline sediment patterns",
      "Maintenance scheduling for municipal water networks",
      "Thermal aging in composite panels"
    ];
    const { observedRequests, streamSearchPapers } = createSearchHarness(
      (request, familyIndex) =>
        Array.from({ length: Math.max(20, request.limit * 4) }, (_, paperIndex) => ({
          paperId: `off-domain-${familyIndex}-${paperIndex}`,
          title: `${unrelatedTitles[paperIndex % unrelatedTitles.length]} ${familyIndex}-${paperIndex}`,
          abstract:
            "Measurements summarize physical materials, seasonal field observations, and infrastructure maintenance.",
          authors: ["Fixture Author"]
        }))
    );
    const node = createTestNode({
      maxResults: 8,
      eventStream: new InMemoryEventStream(),
      streamSearchPapers,
      llm: new JsonLLMClient(
        JSON.stringify({
          shared_anchor: "document retrieval evaluation",
          families: [
            { id: "calibration", axis: "confidence calibration" },
            { id: "shift", axis: "distribution shift" }
          ],
          assumptions: []
        })
      )
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(observedRequests.length).toBeGreaterThanOrEqual(2);
    expect(result.status).toBe("failure");
    expect(result.needsApproval).not.toBe(true);
    expect(`${result.error ?? ""} ${result.summary ?? ""}`).toMatch(
      /corpus|relevan|topic|anchor|family/iu
    );

    const quality = await readJson<CollectCorpusQualityFixture>(
      path.join(runDir, "collect_corpus_quality.json")
    );
    expect(quality.passed).toBe(false);
    expect(quality.observed).toEqual(
      expect.objectContaining({
        relevant_papers: expect.any(Number),
        relevant_share: expect.any(Number),
        covered_query_families: expect.any(Number)
      })
    );
    expect(quality.reasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/\S/u)])
    );
  });

  it("writes anchor-proximate titles as query hints when scientific axes remain unsupported", async () => {
    const { run, runDir } = await createTopicDiscoveryFixture(
      "run-topic-axis-reformulation-hints",
      8
    );
    const { streamSearchPapers } = createSearchHarness(
      (_request, familyIndex) =>
        Array.from({ length: 6 }, (_, paperIndex) => ({
          paperId: `anchor-only-${familyIndex}-${paperIndex}`,
          title: `Document retrieval evaluation overview ${familyIndex}-${paperIndex}`,
          abstract: "The paper surveys document retrieval evaluation protocols without the requested measurement axis.",
          authors: ["Fixture Author"]
        }))
    );
    const node = createTestNode({
      maxResults: 8,
      eventStream: new InMemoryEventStream(),
      streamSearchPapers,
      llm: new JsonLLMClient(
        JSON.stringify({
          shared_anchor: "document retrieval evaluation",
          families: [
            { axis: "confidence calibration" },
            { axis: "distribution shift" }
          ],
          assumptions: []
        })
      )
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    const hints = await readJson<{
      strategy?: string;
      evidence_status?: string;
      candidate_titles?: string[];
    }>(path.join(runDir, "collect_query_reformulation_hints.json"));
    expect(hints).toMatchObject({
      strategy: "anchor_proximate_title_pseudo_relevance_feedback",
      evidence_status: "query_hint_only"
    });
    expect(hints.candidate_titles?.length).toBeGreaterThan(0);
    expect(hints.candidate_titles?.every((title) => /document retrieval evaluation/iu.test(title))).toBe(true);
  });

  it("replaces stale accepted artifacts with an empty snapshot when the latest portfolio fails", async () => {
    const { run, runDir } = await createTopicDiscoveryFixture(
      "run-topic-failed-retry-snapshot",
      8
    );
    await writeFile(
      path.join(runDir, "corpus.jsonl"),
      `${JSON.stringify({
        paper_id: "stale-paper",
        title: "Stale accepted paper from an earlier attempt"
      })}\n`,
      "utf8"
    );
    await writeFile(
      path.join(runDir, "bibtex.bib"),
      "@article{stale-paper, title={Stale accepted paper from an earlier attempt}}\n",
      "utf8"
    );

    const { streamSearchPapers } = createSearchHarness(
      (_request, familyIndex) =>
        familyIndex === 0
          ? Array.from({ length: 6 }, (_, paperIndex) => ({
              paperId: `ranking-stability-${paperIndex}`,
              title:
                `Document retrieval evaluation with ranking stability ` +
                `${paperIndex}`,
              abstract:
                "The study measures ranking stability in document retrieval evaluation.",
              authors: ["Fixture Author"]
            }))
          : Array.from({ length: 6 }, (_, paperIndex) => ({
              paperId: `anchor-only-${paperIndex}`,
              title: `Document retrieval evaluation overview ${paperIndex}`,
              abstract:
                "The study discusses document retrieval evaluation without the requested calibration axis.",
              authors: ["Fixture Author"]
            }))
    );
    const node = createTestNode({
      maxResults: 8,
      eventStream: new InMemoryEventStream(),
      streamSearchPapers,
      llm: new JsonLLMClient(
        JSON.stringify({
          shared_anchor: "document retrieval evaluation",
          families: [
            { axis: "ranking stability" },
            { axis: "confidence calibration" }
          ],
          assumptions: []
        })
      )
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(await readFile(path.join(runDir, "corpus.jsonl"), "utf8")).toBe("");
    expect(await readFile(path.join(runDir, "bibtex.bib"), "utf8")).toBe("");

    const candidateRows = (await readFile(
      path.join(runDir, "collect_topic_discovery_candidates.jsonl"),
      "utf8"
    ))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        evidence_status?: string;
        paper_evidence_allowed?: boolean;
        retrieval_status?: string;
        semantic_review_requested?: boolean;
        semantic_review_selections?: Array<{
          family_id?: string;
          selection_source?: string;
        }>;
        selected_by_semantic_quality?: boolean;
        published_in_corpus?: boolean;
      });
    expect(candidateRows).toHaveLength(12);
    expect(
      candidateRows.every(
        (row) =>
          row.evidence_status === "semantic_screening_candidate_only"
          && row.paper_evidence_allowed === false
          && row.retrieval_status === "retrieved_governance_usable"
      )
    ).toBe(true);
    expect(candidateRows.filter((row) => row.semantic_review_requested)).toHaveLength(12);
    expect(candidateRows.flatMap((row) => row.semantic_review_selections ?? []).filter(
      (selection) => selection.selection_source === "provider_provenance_floor"
    )).toHaveLength(8);
    expect(candidateRows.filter((row) => row.selected_by_semantic_quality)).toHaveLength(6);
    expect(candidateRows.some((row) => row.published_in_corpus)).toBe(false);

    const collectResult = await readJson<{
      collect_attempt_id?: string;
      stored?: number;
      corpusQuality?: CollectCorpusQualityFixture;
    }>(path.join(runDir, "collect_result.json"));
    expect(collectResult.stored).toBe(0);
    expect(collectResult.corpusQuality).toMatchObject({
      passed: false,
      observed: {
        relevant_papers: 6,
        covered_query_families: 1
      }
    });
    const manifest = await readJson<{
      collect_attempt_id?: string;
      status?: string;
      files?: Array<{ source_path?: string; archived_path?: string }>;
    }>(path.join(runDir, "collect_attempt_manifest.json"));
    expect(manifest).toMatchObject({
      collect_attempt_id: collectResult.collect_attempt_id,
      status: "quality_gate_failed"
    });
    const archivedCorpus = manifest.files?.find(
      (file) => file.source_path === "corpus.jsonl"
    );
    expect(archivedCorpus?.archived_path).toBeTruthy();
    expect(
      await readFile(path.join(runDir, archivedCorpus!.archived_path!), "utf8")
    ).toBe("");
    const quality = await readJson<{ collect_attempt_id?: string }>(
      path.join(runDir, "collect_corpus_quality.json")
    );
    const hints = await readJson<{ collect_attempt_id?: string }>(
      path.join(runDir, "collect_query_reformulation_hints.json")
    );
    const queryPlan = await readJson<{ collect_attempt_id?: string }>(
      path.join(runDir, "collect_query_plan.json")
    );
    expect(collectResult.collect_attempt_id).toMatch(/^[a-z0-9-]+$/iu);
    expect(new Set([
      collectResult.collect_attempt_id,
      quality.collect_attempt_id,
      hints.collect_attempt_id,
      queryPlan.collect_attempt_id
    ])).toEqual(new Set([collectResult.collect_attempt_id]));
  });

  it("fails closed before provider search when the structured planner is unavailable", async () => {
    process.env.AUTOLABOS_CONSTRAINT_PROFILE_TIMEOUT_MS = "5";
    process.env.AUTOLABOS_LITERATURE_QUERY_TIMEOUT_MS = "5";

    const { run, runDir } = await createTopicDiscoveryFixture("run-topic-portfolio", 8);
    const { observedRequests, streamSearchPapers } = createSearchHarness(
      (request, familyIndex) =>
        Array.from({ length: request.limit }, (_, paperIndex) => ({
          paperId: `family-${familyIndex}-paper-${paperIndex}`,
          title:
            `Document retrieval confidence calibration with limited annotation budgets ` +
            `${familyIndex}-${paperIndex}`,
          abstract:
            "The paper studies calibrated evidence retrieval under a bounded annotation budget.",
          authors: ["Fixture Author"]
        }))
    );
    const eventStream = new InMemoryEventStream();
    const node = createTestNode({
      maxResults: 8,
      eventStream,
      streamSearchPapers,
      llm: new HangingLLMClient()
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.needsApproval).not.toBe(true);
    expect(observedRequests).toHaveLength(0);
    expect(`${result.error ?? ""} ${result.summary ?? ""}`).toContain(
      "literature_query_timeout_after_5ms"
    );
    expect(
      eventStream.history().some((event) =>
        JSON.stringify(event).includes("literature_query_timeout_after_5ms")
      )
    ).toBe(true);
    const queryPlan = await readJson<{
      version?: number;
      planner?: {
        source?: string;
        failure_reason?: string;
        repair_diagnostic?: {
          strategy?: string;
          reason?: string;
          requiredFamilyCount?: number;
        };
      };
      selected_families?: unknown[];
    }>(path.join(runDir, "collect_query_plan.json"));
    expect(queryPlan.version).toBe(TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT.version);
    expect(queryPlan.planner).toMatchObject({
      source: "deterministic_fallback",
      failure_reason: expect.stringContaining(
        "literature_query_timeout_after_5ms;explicit_scope_timeout_fallback_unavailable:"
      ),
      repair_diagnostic: {
        strategy: "explicit_scope_timeout_fallback_unavailable",
        reason: "no_title_supported_unused_scope_axis",
        requiredFamilyCount: 2
      }
    });
    expect(queryPlan.selected_families).toEqual([]);
  });

  it("uses prior-work probe titles as planner hints without publishing them as corpus evidence", async () => {
    const { run, runDir } = await createTopicDiscoveryFixture(
      "run-topic-prior-work-probe-hints",
      12
    );
    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    await runContext.put("run_brief.raw", [
      "# Research Brief",
      "",
      "## Research Mode",
      "topic_discovery",
      "",
      "## Topic",
      "Review evidence defects under controlled records.",
      "",
      "## Scientific Scope",
      "### Scientific Object",
      "- document review evidence",
      "",
      "### Empirical Problems",
      "- automatic localization under incomplete records",
      "- revision consistency across reviewer rounds",
      "- metric mismatch across result tables",
      "",
      "### Prior-Work Probes",
      "- automatic reviewers detect faulty reasoning",
      "",
      "## Research Question",
      "Which evidence defects alter review conclusions?"
    ].join("\n"));
    const llm = new CapturingJsonLLMClient(JSON.stringify({
      shared_anchor: "document review evidence",
      families: [
        { axis: "automatic localization" },
        { axis: "revision consistency" },
        { axis: "metric mismatch" }
      ],
      assumptions: []
    }));
    const { observedRequests, streamSearchPapers } = createSearchHarness(
      (request, familyIndex) =>
        request.query.includes("automatic reviewers")
          ? [{
              paperId: "paper_prior_probe_only",
              title: "Automatic Reviewers Detect Faulty Reasoning",
              abstract: "A closest-prior vocabulary hint.",
              authors: ["Fixture Author"]
            }]
          : [1, 2].map((paperIndex) => ({
              paperId: `paper_scientific_family_${familyIndex}_${paperIndex}`,
              title: `${request.query} controlled comparison ${familyIndex}-${paperIndex}`,
              abstract: `${request.query} is studied as the central scientific relation.`,
              authors: ["Fixture Author"]
            }))
    );
    const node = createTestNode({
      maxResults: 12,
      eventStream: new InMemoryEventStream(),
      streamSearchPapers,
      llm
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status, JSON.stringify(result)).toBe("success");
    expect(observedRequests).toHaveLength(7);
    expect(observedRequests[0]?.query).toBe(
      "automatic reviewers detect faulty reasoning"
    );
    expect(llm.prompts[0]).toContain(
      "Automatic Reviewers Detect Faulty Reasoning"
    );
    const receipt = await readJson<{
      evidence_status?: string;
      paper_evidence_allowed?: boolean;
      candidate_titles?: string[];
    }>(path.join(runDir, "collect_prior_work_probe_receipt.json"));
    expect(receipt).toMatchObject({
      evidence_status: "query_hint_only",
      paper_evidence_allowed: false,
      candidate_titles: ["Automatic Reviewers Detect Faulty Reasoning"]
    });
    const corpus = await readFile(path.join(runDir, "corpus.jsonl"), "utf8");
    const candidatePool = await readFile(
      path.join(runDir, "collect_topic_discovery_candidates.jsonl"),
      "utf8"
    );
    expect(corpus).not.toContain("paper_prior_probe_only");
    expect(candidatePool).not.toContain("paper_prior_probe_only");
    const queryPlan = await readJson<{
      selected_families?: Array<{
        query_family?: string;
        source?: string;
        topic_discovery_family?: {
          sharedAnchorTerms?: string[];
          axisTerms?: string[];
        };
      }>;
      planned_searches?: Array<{
        query_family?: string;
        retrieval_lane?: string;
        topic_discovery_family?: {
          axisTerms?: string[];
        };
      }>;
      prior_work_probe_receipt?: {
        paper_evidence_allowed?: boolean;
      };
    }>(path.join(runDir, "collect_query_plan.json"));
    expect(queryPlan.selected_families).toHaveLength(3);
    expect(new Set(queryPlan.selected_families?.map(
      (family) => family.query_family
    )).size).toBe(3);
    expect(queryPlan.selected_families?.every(
      (family) => family.source === "llm_query_planner"
    )).toBe(true);
    expect(queryPlan.selected_families?.every(
      (family) => JSON.stringify(
        family.topic_discovery_family?.sharedAnchorTerms
      ) === JSON.stringify(["document", "review", "evidence"])
    )).toBe(true);
    expect(queryPlan.selected_families?.flatMap(
      (family) => family.topic_discovery_family?.axisTerms ?? []
    )).toContain("automat");
    expect(queryPlan.selected_families?.flatMap(
      (family) => family.topic_discovery_family?.axisTerms ?? []
    )).not.toContain("automatic");
    expect(queryPlan.planned_searches).toHaveLength(6);
    expect(new Set(queryPlan.planned_searches?.map(
      (search) => search.retrieval_lane
    ))).toEqual(new Set(["broad_relevance", "recent_direct_prior"]));
    expect(queryPlan.planned_searches?.flatMap(
      (search) => search.topic_discovery_family?.axisTerms ?? []
    )).toContain("automatic");
    expect(queryPlan.prior_work_probe_receipt?.paper_evidence_allowed).toBe(false);
  });

  it("does not let one explicit query bypass the multi-family topic-discovery gate", async () => {
    const { run } = await createTopicDiscoveryFixture(
      "run-topic-explicit-query",
      8,
      { query: '"document retrieval evaluation" confidence calibration' }
    );
    const { observedRequests, streamSearchPapers } = createSearchHarness(() => []);
    const node = createTestNode({
      maxResults: 8,
      eventStream: new InMemoryEventStream(),
      streamSearchPapers,
      llm: new JsonLLMClient("{}")
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.needsApproval).not.toBe(true);
    expect(observedRequests).toHaveLength(0);
    expect(`${result.error ?? ""} ${result.summary ?? ""}`).toMatch(/query plan/iu);
  });

  it("does not let additional collection bypass whole-corpus family provenance", async () => {
    const { run, runDir } = await createTopicDiscoveryFixture(
      "run-topic-additional-bypass",
      8,
      { additional: 4 }
    );
    await writeFile(
      path.join(runDir, "collect_request.json"),
      JSON.stringify({ query: "stale configured request", limit: 99 }),
      "utf8"
    );
    const { observedRequests, streamSearchPapers } = createSearchHarness(() => []);
    const node = createTestNode({
      maxResults: 8,
      eventStream: new InMemoryEventStream(),
      streamSearchPapers,
      llm: new JsonLLMClient(
        JSON.stringify({
          shared_anchor: "document retrieval evaluation",
          families: [
            { axis: "confidence calibration" },
            { axis: "distribution shift" }
          ],
          assumptions: []
        })
      )
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.needsApproval).not.toBe(true);
    expect(observedRequests).toHaveLength(0);
    expect(`${result.error ?? ""} ${result.summary ?? ""}`).toContain(
      "full replace-and-reaudit pass"
    );
    const context = await readJson<{ items?: Array<{ key?: string; value?: unknown }> }>(
      path.join(runDir, "memory", "run_context.json")
    );
    expect(context.items?.find((item) => item.key === "collect_papers.last_error")?.value).toContain(
      "family provenance"
    );
    const failureResult = await readJson<{
      collect_attempt_id?: string;
      completed?: boolean;
      fetchError?: string;
    }>(path.join(runDir, "collect_result.json"));
    expect(failureResult).toMatchObject({
      completed: false,
      fetchError: expect.stringContaining("family provenance")
    });
    expect(
      context.items?.find((item) => item.key === "collect_papers.last_attempt_id")?.value
    ).toBe(failureResult.collect_attempt_id);
    expect(
      context.items?.find((item) => item.key === "collect_papers.active_attempt_id")?.value
    ).toBeNull();
    expect(
      await readJson(path.join(runDir, "collect_request.json"))
    ).toMatchObject({
      collect_attempt_id: failureResult.collect_attempt_id,
      status: "planning_failed",
      request: null
    });
    expect(
      await readJson(path.join(runDir, "collect_attempt_manifest.json"))
    ).toMatchObject({
      collect_attempt_id: failureResult.collect_attempt_id,
      status: "planning_failed",
      phase: "planning"
    });
  });
});
