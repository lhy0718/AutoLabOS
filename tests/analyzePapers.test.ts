import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureScaffold, resolveAppPaths } from "../src/config.js";
import { createAnalyzePapersNode, retryResolvedSourceAfterLatePdfRecovery } from "../src/core/nodes/analyzePapers.js";
import { createGenerateHypothesesNode } from "../src/core/nodes/generateHypotheses.js";
import { InMemoryEventStream } from "../src/core/events.js";
import { RunStore } from "../src/core/runs/runStore.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import { RunRecord } from "../src/types.js";
import { LLMCompleteOptions, MockLLMClient } from "../src/core/llm/client.js";
import { ResponsesPdfAnalysisClient } from "../src/integrations/openai/responsesPdfAnalysisClient.js";
import { CodexOAuthCompletionError } from "../src/integrations/codex/oauthCompletionError.js";
import { RunContextMemory } from "../src/core/memory/runContextMemory.js";
import { persistCollectAttemptArchive } from "../src/core/collection/collectAttemptArchive.js";
import { makeTopicProbeComputeBudgetDeclaration } from "./support/topicProbeComputeBudget.js";
import {
  buildTopicDiscoveryCandidateFamilySignature,
  normalizeTopicDiscoveryCandidateTerms,
  normalizeTopicDiscoveryScientificObjectTerms,
  TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
  TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION
} from "../src/core/topicDiscoveryScientificTerms.js";
import {
  buildTopicDiscoverySemanticAuditPrompt,
  TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION,
  TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_CALLS,
  TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_FALLBACK_PARTITIONS,
  TOPIC_DISCOVERY_SEMANTIC_TIMEOUT_PARTITION_POLICY
} from "../src/core/collection/topicDiscoverySemanticAudit.js";
import {
  assessTopicDiscoveryPaperRelevance,
  buildTopicDiscoveryCorpusRelevanceProfile,
  TOPIC_DISCOVERY_CORPUS_QUALITY_STRATEGY,
  TOPIC_DISCOVERY_CORPUS_QUALITY_VERSION
} from "../src/core/collection/topicDiscoveryCorpusQuality.js";
import {
  TOPIC_DISCOVERY_CANDIDATE_SIDECAR_VERSION,
  TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT
} from "../src/core/collection/topicDiscoveryArtifactVersions.js";
import {
  buildCandidatePriorSearchPlan,
  buildCandidatePriorSearchReceipt,
  validateCandidatePriorSearchReceipt
} from "../src/core/candidatePriorSearch.js";
import { buildPriorAbsorptionCandidateContract } from "../src/core/priorAbsorption.js";
import type { HypothesisCandidate } from "../src/core/analysis/researchPlanning.js";

const tempDirs: string[] = [];
const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalAnalysisExtractTimeout = process.env.AUTOLABOS_ANALYSIS_EXTRACT_TIMEOUT_MS;
const originalAnalysisPlannerTimeout = process.env.AUTOLABOS_ANALYSIS_PLANNER_TIMEOUT_MS;

function makeCodexProviderConfig() {
  return {
    llm_mode: "codex_chatgpt_only" as const,
    codex: {
      model: "gpt-5.3-codex",
      chat_model: "gpt-5.3-codex",
      reasoning_effort: "medium" as const,
      chat_reasoning_effort: "low" as const,
      command_reasoning_effort: "low" as const,
      fast_mode: false,
      chat_fast_mode: false,
      auth_required: true
    }
  };
}

function makeCodexReadyStub() {
  return {
    checkCliAvailable: async () => ({ ok: true, detail: "codex available" }),
    checkLoginStatus: async () => ({ ok: true, detail: "logged in" }),
    checkEnvironmentReadiness: async () => []
  } as any;
}

async function seedCodexOAuthHome(root: string): Promise<void> {
  process.env.HOME = root;
  await mkdir(path.join(root, ".codex"), { recursive: true });
  await writeFile(
    path.join(root, ".codex", "auth.json"),
    JSON.stringify({
      tokens: {
        access_token: "test-codex-access-token",
        account_id: "test-account"
      }
    }),
    "utf8"
  );
}

afterEach(async () => {
  process.chdir(originalCwd);
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalAnalysisExtractTimeout === undefined) {
    delete process.env.AUTOLABOS_ANALYSIS_EXTRACT_TIMEOUT_MS;
  } else {
    process.env.AUTOLABOS_ANALYSIS_EXTRACT_TIMEOUT_MS = originalAnalysisExtractTimeout;
  }
  if (originalAnalysisPlannerTimeout === undefined) {
    delete process.env.AUTOLABOS_ANALYSIS_PLANNER_TIMEOUT_MS;
  } else {
    process.env.AUTOLABOS_ANALYSIS_PLANNER_TIMEOUT_MS = originalAnalysisPlannerTimeout;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

class SequenceJsonLLM extends MockLLMClient {
  private index = 0;

  constructor(private readonly outputs: string[]) {
    super();
  }

  override async complete(_prompt: string): Promise<{ text: string }> {
    const output = this.outputs[Math.min(this.index, this.outputs.length - 1)] ?? "";
    this.index += 1;
    return { text: output };
  }
}

class CountingJsonLLM extends MockLLMClient {
  private index = 0;
  callCount = 0;

  constructor(private readonly outputs: string[]) {
    super();
  }

  override async complete(_prompt: string): Promise<{ text: string }> {
    const output = this.outputs[Math.min(this.index, this.outputs.length - 1)] ?? "";
    this.index += 1;
    this.callCount += 1;
    return { text: output };
  }
}

class FixedErrorLLM extends MockLLMClient {
  constructor(private readonly error: Error) {
    super();
  }

  override async complete(_prompt: string): Promise<{ text: string }> {
    throw this.error;
  }
}

class SequenceResponseLlm extends MockLLMClient {
  private index = 0;

  constructor(private readonly outputs: Array<string | Error>) {
    super();
  }

  override async complete(_prompt: string): Promise<{ text: string }> {
    const output = this.outputs[Math.min(this.index, this.outputs.length - 1)];
    this.index += 1;
    if (output instanceof Error) {
      throw output;
    }
    return { text: output ?? "" };
  }
}

class PlannerAwarePaperLlm extends MockLLMClient {
  constructor(
    private readonly options: {
      abortTitle?: string;
      summary?: string;
      claim?: string;
      delayMs?: number;
    } = {}
  ) {
    super();
  }

  override async complete(prompt: string, opts?: LLMCompleteOptions): Promise<{ text: string }> {
    if (this.options.delayMs && this.options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }
    if (this.options.abortTitle && prompt.includes(this.options.abortTitle)) {
      throw new Error("Operation aborted by user");
    }
    if (opts?.systemPrompt?.includes("planning agent")) {
      return {
        text: JSON.stringify({
          focus_sections: ["methods"],
          target_claims: ["claim"],
          extraction_priorities: ["metrics"],
          verification_checks: ["source-grounded"],
          risk_flags: []
        })
      };
    }
    return {
      text: jsonOutput(this.options.summary ?? "summary", this.options.claim ?? "claim")
    };
  }
}

class TitleSelectiveHangingExtractorLLM extends MockLLMClient {
  constructor(
    private readonly options: {
      hangingTitle: string;
      summary?: string;
      claim?: string;
    }
  ) {
    super();
  }

  override async complete(prompt: string, opts?: LLMCompleteOptions): Promise<{ text: string }> {
    if (opts?.systemPrompt?.includes("planning agent")) {
      return {
        text: JSON.stringify({
          focus_sections: ["methods"],
          target_claims: ["claim"],
          extraction_priorities: ["metrics"],
          verification_checks: ["source-grounded"],
          risk_flags: []
        })
      };
    }
    if (
      opts?.systemPrompt?.includes("scientific literature analyst")
      && prompt.includes(this.options.hangingTitle)
    ) {
      return await new Promise<{ text: string }>((_resolve, reject) => {
        if (opts.abortSignal?.aborted) {
          reject(new Error("Operation aborted by user"));
          return;
        }
        opts.abortSignal?.addEventListener(
          "abort",
          () => reject(new Error("Operation aborted by user")),
          { once: true }
        );
      });
    }
    return {
      text: jsonOutput(this.options.summary ?? "summary", this.options.claim ?? "claim")
    };
  }
}

class HangingPlannerOnlyLLM extends MockLLMClient {
  override async complete(_prompt: string, opts?: LLMCompleteOptions): Promise<{ text: string }> {
    if (opts?.systemPrompt?.includes("planning agent")) {
      return await new Promise<{ text: string }>((_resolve, reject) => {
        if (opts.abortSignal?.aborted) {
          reject(new Error("Operation aborted by user"));
          return;
        }
        opts.abortSignal?.addEventListener("abort", () => reject(new Error("Operation aborted by user")), {
          once: true
        });
      });
    }
    return {
      text: jsonOutput("reviewed summary", "claim")
    };
  }
}

class PlannerThenHangingResponsesPdfClient {
  callCount = 0;

  async hasApiKey(): Promise<boolean> {
    return true;
  }

  async analyzePdf(args: { abortSignal?: AbortSignal; systemPrompt?: string }): Promise<{ text: string }> {
    this.callCount += 1;
    if (args.systemPrompt?.includes("planning agent")) {
      return {
        text: JSON.stringify({
          focus_sections: ["methods"],
          target_claims: ["claim"],
          extraction_priorities: ["metrics"],
          verification_checks: ["source-grounded"],
          risk_flags: []
        })
      };
    }
    void args;
    return await new Promise<{ text: string }>(() => undefined);
  }
}

class RerankHangingLLM extends MockLLMClient {
  override async complete(_prompt: string, opts?: LLMCompleteOptions): Promise<{ text: string }> {
    if (opts?.systemPrompt?.includes("You rerank scientific papers")) {
      return await new Promise<{ text: string }>((_resolve, reject) => {
        if (opts.abortSignal?.aborted) {
          reject(new Error("Operation aborted by user"));
          return;
        }
        opts.abortSignal?.addEventListener(
          "abort",
          () => reject(new Error("Operation aborted by user")),
          { once: true }
        );
      });
    }
    return {
      text: jsonOutput("summary", "claim")
    };
  }
}

class ImagePayloadTimeoutLLM extends MockLLMClient {
  extractorCallsWithImages = 0;
  extractorCallsWithoutImages = 0;

  override async complete(_prompt: string, opts?: LLMCompleteOptions): Promise<{ text: string }> {
    if (opts?.systemPrompt?.includes("planning agent")) {
      return {
        text: JSON.stringify({
          focus_sections: ["methods"],
          target_claims: ["claim"],
          extraction_priorities: ["metrics"],
          verification_checks: ["source-grounded"],
          risk_flags: []
        })
      };
    }
    if (opts?.systemPrompt?.includes("verification agent")) {
      return {
        text: jsonOutput("reviewed summary", "reviewed claim")
      };
    }
    if (opts?.systemPrompt?.includes("scientific literature analyst")) {
      if ((opts.inputImagePaths?.length ?? 0) > 0) {
        this.extractorCallsWithImages += 1;
        return await new Promise<{ text: string }>((_resolve, reject) => {
          if (opts.abortSignal?.aborted) {
            reject(new Error("Operation aborted by user"));
            return;
          }
          opts.abortSignal?.addEventListener(
            "abort",
            () => reject(new Error("Operation aborted by user")),
            { once: true }
          );
        });
      }
      this.extractorCallsWithoutImages += 1;
      return {
        text: jsonOutput("summary without images", "claim without images")
      };
    }
    return {
      text: jsonOutput("summary", "claim")
    };
  }
}

class FullTextThenAbstractFallbackLLM extends MockLLMClient {
  extractorCallsWithImages = 0;
  extractorCallsWithoutImages = 0;
  extractorCallsAbstract = 0;

  override async complete(prompt: string, opts?: LLMCompleteOptions): Promise<{ text: string }> {
    if (opts?.systemPrompt?.includes("planning agent")) {
      return {
        text: JSON.stringify({
          focus_sections: ["methods"],
          target_claims: ["claim"],
          extraction_priorities: ["metrics"],
          verification_checks: ["source-grounded"],
          risk_flags: []
        })
      };
    }
    if (opts?.systemPrompt?.includes("verification agent")) {
      return {
        text: jsonOutput("reviewed abstract fallback summary", "reviewed abstract fallback claim")
      };
    }
    if (opts?.systemPrompt?.includes("scientific literature analyst")) {
      if (prompt.includes("Source type: abstract")) {
        this.extractorCallsAbstract += 1;
        return {
          text: jsonOutput("abstract fallback summary", "abstract fallback claim")
        };
      }
      if ((opts.inputImagePaths?.length ?? 0) > 0) {
        this.extractorCallsWithImages += 1;
      } else {
        this.extractorCallsWithoutImages += 1;
      }
      return await new Promise<{ text: string }>((_resolve, reject) => {
        if (opts.abortSignal?.aborted) {
          reject(new Error("Operation aborted by user"));
          return;
        }
        opts.abortSignal?.addEventListener(
          "abort",
          () => reject(new Error("Operation aborted by user")),
          { once: true }
        );
      });
    }
    return {
      text: jsonOutput("summary", "claim")
    };
  }
}

class TimeoutOnlyExtractorLLM extends MockLLMClient {
  callCount = 0;

  override async complete(_prompt: string, opts?: LLMCompleteOptions): Promise<{ text: string }> {
    this.callCount += 1;
    if (opts?.systemPrompt?.includes("planning agent")) {
      return {
        text: JSON.stringify({
          focus_sections: ["methods"],
          target_claims: ["claim"],
          extraction_priorities: ["metrics"],
          verification_checks: ["source-grounded"],
          risk_flags: []
        })
      };
    }
    if (opts?.systemPrompt?.includes("verification agent")) {
      return {
        text: jsonOutput("reviewed summary", "reviewed claim")
      };
    }
    if (opts?.systemPrompt?.includes("scientific literature analyst")) {
      return await new Promise<{ text: string }>((_resolve, reject) => {
        if (opts.abortSignal?.aborted) {
          reject(new Error("Operation aborted by user"));
          return;
        }
        opts.abortSignal?.addEventListener(
          "abort",
          () => reject(new Error("Operation aborted by user")),
          { once: true }
        );
      });
    }
    return {
      text: jsonOutput("summary", "claim")
    };
  }
}


function makeRun(runId: string): RunRecord {
  return {
    version: 3,
    workflowVersion: 3,
    id: runId,
    title: "Multi-Agent Collaboration",
    topic: "Multi-Agent Collaboration",
    constraints: [],
    objectiveMetric: "primary_score >= 0.9",
    status: "running",
    currentNode: "analyze_papers",
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

async function writeCorpus(runId: string, rows: unknown[]): Promise<void> {
  const dir = path.join(".autolabos", "runs", runId);
  await mkdir(path.join(dir, "memory"), { recursive: true });
  await writeFile(
    path.join(dir, "corpus.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf8"
  );
}

async function writeCollectEnrichment(runId: string, entries: unknown[]): Promise<void> {
  const dir = path.join(".autolabos", "runs", runId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "collect_enrichment.jsonl"),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8"
  );
}

async function writeCollectResult(runId: string, value: unknown): Promise<void> {
  const dir = path.join(".autolabos", "runs", runId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "collect_result.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeTopicDiscoveryCollectLineage(input: {
  run: RunRecord;
  collectAttemptId: string;
  rows: Array<{
    paper_id: string;
    title: string;
    abstract: string;
    query_families?: string[];
    lexical_query_families?: string[];
  }>;
  candidateRows?: Array<{
    paper_id: string;
    title: string;
    abstract: string;
    query_families?: string[];
    lexical_query_families?: string[];
  }>;
  sharedAnchorTerms?: string[];
  families: Array<{
    queryFamily: string;
    query: string;
    axisTerms: string[];
    lens: string;
    contributionIntent: string;
  }>;
  reviewedPairs?: Array<{
    paper_id: string;
    family_id: string;
    selection_source?: "lexical_match" | "provider_provenance_floor";
    verdict?: "direct_support" | "application_only" | "uncertain";
  }>;
  queryPlanContractOverrides?: {
    version?: number;
    term_normalization_version?: number;
    candidate_recall_semantics_version?: number;
  };
}): Promise<void> {
  const runDir = path.join(".autolabos", "runs", input.run.id);
  const sharedAnchorTerms = [
    ...new Set(normalizeTopicDiscoveryScientificObjectTerms(
      (input.sharedAnchorTerms ?? ["document", "retrieval"]).join(" ")
    ))
  ];
  const families = input.families.map((family) => ({
    ...family,
    axisTerms: [
      ...new Set(normalizeTopicDiscoveryCandidateTerms(
        family.axisTerms.join(" ")
      ))
    ]
  }));
  const candidateRows = input.candidateRows ?? input.rows;
  const reviewedPairs = (input.reviewedPairs ?? candidateRows.flatMap((row) =>
    (row.query_families ?? []).map((familyId) => ({
      paper_id: row.paper_id,
      family_id: familyId
    }))
  )).map((pair) => ({
    ...pair,
    selection_source: pair.selection_source ?? "lexical_match" as const,
    verdict: pair.verdict ?? "direct_support" as const
  }));
  const reviewedPaperIds = new Set(reviewedPairs.map((pair) => pair.paper_id));
  const retainedPaperIds = new Set(input.rows.map((row) => row.paper_id));
  const lexicalFamiliesByPaper = new Map(
    candidateRows.map((row) => [
      row.paper_id,
      row.lexical_query_families ?? row.query_families ?? []
    ] as const)
  );
  const lexicalPaperIds = new Set(
    candidateRows
      .filter((row) => (lexicalFamiliesByPaper.get(row.paper_id)?.length ?? 0) > 0)
      .map((row) => row.paper_id)
  );
  const candidateByPaper = new Map(
    candidateRows.map((row) => [row.paper_id, row] as const)
  );
  const titleByPaper = new Map(
    candidateRows.map((row) => [row.paper_id, row.title] as const)
  );
  const judgments = reviewedPairs.map((pair) => pair.verdict === "direct_support"
    ? {
        paper_id: pair.paper_id,
        family_id: pair.family_id,
        verdict: pair.verdict,
        reason: "The supplied title directly supports the family contract.",
        evidence_span: titleByPaper.get(pair.paper_id) ?? ""
      }
    : {
        paper_id: pair.paper_id,
        family_id: pair.family_id,
        verdict: pair.verdict,
        reason: "The supplied record does not directly support this family contract."
      }
  );
  const payload = {
    version: TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION,
    term_normalization_version: TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION,
    candidate_recall_semantics_version:
      TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
    papers: Array.from(reviewedPaperIds).map((paperId) => {
      const row = candidateByPaper.get(paperId);
      if (!row) {
        throw new Error("semantic_review_candidate_fixture_missing");
      }
      return {
        paper_id: row.paper_id,
        title: row.title,
        abstract: Array.from(row.abstract).slice(0, 2_000).join("")
      };
    }),
    family_contracts: families.map((family) => ({
      family_id: family.queryFamily,
      query: family.query,
      axis_terms: family.axisTerms,
      lens: family.lens,
      contribution_intent: family.contributionIntent
    })),
    requested_pairs: reviewedPairs.map((pair) => ({
      paper_id: pair.paper_id,
      family_id: pair.family_id,
      selection_source: pair.selection_source
    }))
  };
  const payloadSha256 = createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
  const reviewerInputBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  const promptSha256 = createHash("sha256")
    .update(buildTopicDiscoverySemanticAuditPrompt(payload), "utf8")
    .digest("hex");
  const responseSha256 = "d".repeat(64);
  const execution = {
    policy: TOPIC_DISCOVERY_SEMANTIC_TIMEOUT_PARTITION_POLICY,
    maximum_calls: TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_CALLS,
    maximum_fallback_partitions:
      TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_FALLBACK_PARTITIONS,
    total_deadline_ms: 480_000,
    fallback_partition_size: Math.max(
      1,
      Math.ceil(reviewedPairs.length / TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_FALLBACK_PARTITIONS)
    ),
    calls_started: 1,
    calls_completed: 1,
    cumulative_reviewer_input_bytes: reviewerInputBytes,
    calls: [{
      call_index: 1,
      mode: "primary",
      pair_start_index: 0,
      pair_end_index_exclusive: reviewedPairs.length,
      requested_pair_count: reviewedPairs.length,
      reviewer_input_sha256: payloadSha256,
      reviewer_input_bytes: reviewerInputBytes,
      prompt_sha256: promptSha256,
      response_sha256: responseSha256,
      outcome: "complete"
    }]
  };
  const counts = {
    requested_pairs: reviewedPairs.length,
    reviewed_pairs: reviewedPairs.length,
    budget_excluded_pairs: 0,
    returned_judgments: reviewedPairs.length,
    direct_support: reviewedPairs.filter(
      (pair) => pair.verdict === "direct_support"
    ).length,
    application_only: reviewedPairs.filter(
      (pair) => pair.verdict === "application_only"
    ).length,
    uncertain: reviewedPairs.filter(
      (pair) => pair.verdict === "uncertain"
    ).length,
    omitted_judgments: 0,
    duplicate_judgments: 0,
    conflicting_judgments: 0,
    invented_judgments: 0,
    malformed_judgments: 0,
    protocol_violations: 0
  };
  const familyCounts = new Map(
    families.map((family) => [
      family.queryFamily,
      reviewedPairs.filter((pair) => pair.family_id === family.queryFamily).length
    ] as const)
  );
  const familyVerdictCounts = new Map(
    families.map((family) => {
      const familyPairs = reviewedPairs.filter(
        (pair) => pair.family_id === family.queryFamily
      );
      return [family.queryFamily, {
        direct: familyPairs.filter(
          (pair) => pair.verdict === "direct_support"
        ).length,
        applicationOnly: familyPairs.filter(
          (pair) => pair.verdict === "application_only"
        ).length,
        uncertain: familyPairs.filter(
          (pair) => pair.verdict === "uncertain"
        ).length
      }] as const;
    })
  );
  const retainedFamilyCounts = new Map(
    families.map((family) => [
      family.queryFamily,
      input.rows.filter((row) =>
        row.query_families?.includes(family.queryFamily)
      ).length
    ] as const)
  );
  const lexicalFamilyCounts = new Map(
    families.map((family) => [
      family.queryFamily,
      candidateRows.filter((row) =>
        lexicalFamiliesByPaper.get(row.paper_id)?.includes(family.queryFamily)
      ).length
    ] as const)
  );
  const providerFamilyCounts = new Map(
    families.map((family) => [
      family.queryFamily,
      reviewedPairs.filter((pair) =>
        pair.family_id === family.queryFamily
        && pair.selection_source === "provider_provenance_floor"
      ).length
    ] as const)
  );
  const lexicalRequestedPairCount = reviewedPairs.filter(
    (pair) => pair.selection_source === "lexical_match"
  ).length;
  const providerRequestedPairCount = reviewedPairs.length - lexicalRequestedPairCount;
  const coveredQueryFamilies = families.filter(
    (family) => {
      const reviewed = familyCounts.get(family.queryFamily) ?? 0;
      const direct = familyVerdictCounts.get(family.queryFamily)?.direct ?? 0;
      return direct >= 2 && reviewed > 0 && direct / reviewed >= 0.5;
    }
  ).length;
  const relevanceProfile = buildTopicDiscoveryCorpusRelevanceProfile(
    families.map((family) => ({
      queryFamily: family.queryFamily,
      query: family.query,
      source: "llm_query_planner",
      sharedAnchorTerms,
      axisTerms: family.axisTerms,
      lens: family.lens,
      contributionIntent: family.contributionIntent,
      contractSource: "planner_declared" as const
    }))
  );
  const candidateRelevance = candidateRows.map((row) =>
    assessTopicDiscoveryPaperRelevance({
      row: { ...row, authors: [] },
      profile: relevanceProfile,
      eligibleQueryFamilies: new Set(row.query_families ?? [])
    })
  );
  const corpusQuality = {
    version: TOPIC_DISCOVERY_CORPUS_QUALITY_VERSION,
    term_normalization_version: TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION,
    candidate_recall_semantics_version:
      TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
    collect_attempt_id: input.collectAttemptId,
    research_mode: "topic_discovery",
    strategy: TOPIC_DISCOVERY_CORPUS_QUALITY_STRATEGY,
    generated_at: new Date().toISOString(),
    passed: true,
    reasons: [],
    thresholds: {
      minimum_shared_anchor_terms: 2,
      minimum_relevant_papers: 8,
      minimum_covered_query_families: 2,
      minimum_relevant_papers_per_family: 2,
      minimum_direct_support_per_family: 2,
      minimum_semantic_precision_per_family: 0.5,
      maximum_anchor_window_tokens: 12,
      minimum_axis_term_matches: 2,
      minimum_axis_term_match_ratio: 2 / 3,
      maximum_anchor_axis_window_tokens: 24
    },
    observed: {
      total_papers: candidateRows.length,
      relevant_papers: retainedPaperIds.size,
      relevant_share: candidateRows.length > 0
        ? counts.direct_support / candidateRows.length
        : 0,
      lexical_relevant_papers: lexicalPaperIds.size,
      semantic_requested_papers: reviewedPaperIds.size,
      direct_support_papers: new Set(
        reviewedPairs
          .filter((pair) => pair.verdict === "direct_support")
          .map((pair) => pair.paper_id)
      ).size,
      application_only_pairs: counts.application_only,
      uncertain_pairs: counts.uncertain,
      shared_anchor_terms: sharedAnchorTerms,
      required_anchor_matches_per_paper: sharedAnchorTerms.length,
      anchor_proximate_papers: candidateRelevance.filter(
        (relevance) => relevance.anchorProximate
      ).length,
      anchor_axis_proximate_papers: candidateRelevance.filter(
        (relevance) => relevance.anchorAxisProximate
      ).length,
      covered_query_families: coveredQueryFamilies
    },
    query_families: families.map((family) => ({
      query_family: family.queryFamily,
      query: family.query,
      source: "llm_query_planner",
      positive_terms: family.axisTerms,
      axis_terms: family.axisTerms,
      lens: family.lens,
      contribution_intent: family.contributionIntent,
      contract_source: "planner_declared",
      canonical_family_signature: buildTopicDiscoveryCandidateFamilySignature({
        sharedAnchorTerms,
        axisTerms: family.axisTerms
      }),
      required_axis_matches: family.axisTerms.length,
      lexical_relevant_paper_count:
        lexicalFamilyCounts.get(family.queryFamily) ?? 0,
      semantic_reviewed_paper_count: familyCounts.get(family.queryFamily) ?? 0,
      provider_recall_paper_count:
        providerFamilyCounts.get(family.queryFamily) ?? 0,
      direct_support_paper_count:
        familyVerdictCounts.get(family.queryFamily)?.direct ?? 0,
      qualifies_for_coverage: (() => {
        const reviewed = familyCounts.get(family.queryFamily) ?? 0;
        const direct = familyVerdictCounts.get(family.queryFamily)?.direct ?? 0;
        return direct >= 2 && reviewed > 0 && direct / reviewed >= 0.5;
      })(),
      application_only_paper_count:
        familyVerdictCounts.get(family.queryFamily)?.applicationOnly ?? 0,
      uncertain_paper_count:
        familyVerdictCounts.get(family.queryFamily)?.uncertain ?? 0,
      semantic_precision: (familyCounts.get(family.queryFamily) ?? 0) > 0
        ? (familyVerdictCounts.get(family.queryFamily)?.direct ?? 0)
          / (familyCounts.get(family.queryFamily) ?? 0)
        : 0,
      retained_paper_count: retainedFamilyCounts.get(family.queryFamily) ?? 0,
      relevant_paper_count: retainedFamilyCounts.get(family.queryFamily) ?? 0
    })),
    semantic_review: {
      version: TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION,
      status: "complete",
      prompt_sha256: promptSha256,
      response_sha256: responseSha256,
      reviewer_input_sha256: payloadSha256,
      reviewer_input_bytes: reviewerInputBytes,
      limits: {
        max_pairs: 64,
        max_input_bytes: 131_072,
        abstract_chars: 2_000,
        timeout_ms: 120_000
      },
      counts,
      recall: {
        provider_recall_floor_per_family: 8,
        lexical_requested_pairs: lexicalRequestedPairCount,
        provider_provenance_requested_pairs: providerRequestedPairCount
      },
      execution,
      reasons: [],
      protocol_violations: []
    },
    semantic_judgments: judgments,
    retained_paper_ids: Array.from(retainedPaperIds),
    excluded_paper_ids: candidateRows
      .map((row) => row.paper_id)
      .filter((paperId) => !retainedPaperIds.has(paperId))
  };
  await writeFile(path.join(runDir, "collect_generation.json"), JSON.stringify({
    version: 1,
    kind: "collect_generation",
    run_id: input.run.id,
    collect_attempt_id: input.collectAttemptId,
    started_at: new Date().toISOString()
  }), "utf8");
  await writeFile(path.join(runDir, "collect_query_plan.json"), JSON.stringify({
    ...TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT,
    ...input.queryPlanContractOverrides,
    collect_attempt_id: input.collectAttemptId,
    research_mode: "topic_discovery",
    strategy: "topic_portfolio",
    selected_families: families.map((family) => ({
      query: family.query,
      query_family: family.queryFamily,
      source: "llm_query_planner",
      topic_discovery_family: {
        familyId: family.queryFamily,
        sharedAnchorTerms,
        axisTerms: family.axisTerms,
        lens: family.lens,
        contributionIntent: family.contributionIntent,
        contractSource: "planner_declared"
      }
    }))
  }), "utf8");
  await writeFile(path.join(runDir, "collect_semantic_review_input.json"), JSON.stringify({
    version: 1,
    collect_attempt_id: input.collectAttemptId,
    evidence_status: "semantic_review_input_only",
    paper_evidence_allowed: false,
    reviewer_identity: "fixture",
    payload_sha256: payloadSha256,
    payload
  }), "utf8");
  await writeFile(path.join(runDir, "collect_semantic_review.json"), JSON.stringify({
    version: TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION,
    collect_attempt_id: input.collectAttemptId,
    evidence_status: "semantic_review_judgment_only",
    paper_evidence_allowed: false,
    reviewer_identity: "fixture",
    reviewer_input_sha256: payloadSha256,
    status: "complete",
    prompt_sha256: promptSha256,
    response_sha256: responseSha256,
    limits: {
      max_pairs: 64,
      max_input_bytes: 131_072,
      abstract_chars: 2_000,
      timeout_ms: 120_000
    },
    reviewer_input_bytes: reviewerInputBytes,
    counts,
    recall: {
      provider_recall_floor_per_family: 8,
      lexical_requested_pairs: lexicalRequestedPairCount,
      provider_provenance_requested_pairs: providerRequestedPairCount
    },
    execution,
    reasons: [],
    protocol_violations: [],
    judgments
  }), "utf8");
  await writeFile(path.join(runDir, "collect_result.json"), JSON.stringify({
    collect_attempt_id: input.collectAttemptId,
    completed: true,
    fetched: candidateRows.length,
    stored: input.rows.length,
    corpusQuality
  }), "utf8");
  await writeFile(
    path.join(runDir, "collect_corpus_quality.json"),
    JSON.stringify(corpusQuality),
    "utf8"
  );
  await writeFile(
    path.join(runDir, "collect_topic_discovery_candidates.jsonl"),
    `${candidateRows.map((row) => {
      const selections = reviewedPairs
        .filter((pair) => pair.paper_id === row.paper_id)
        .map((pair) => ({
          family_id: pair.family_id,
          selection_source: pair.selection_source
        }));
      return JSON.stringify({
        ...row,
        schema_version: TOPIC_DISCOVERY_CANDIDATE_SIDECAR_VERSION,
        collect_attempt_id: input.collectAttemptId,
        evidence_status: "semantic_screening_candidate_only",
        paper_evidence_allowed: false,
        retrieval_status: "retrieved_governance_usable",
        query_families: row.query_families ?? [],
        family_retrieval_ranks: (row.query_families ?? []).map((familyId) => ({
          family_id: familyId,
          rank: candidateRows
            .filter((candidate) =>
              candidate.query_families?.includes(familyId)
            )
            .findIndex((candidate) => candidate.paper_id === row.paper_id) + 1
        })),
        canonical_search_source: "semantic_scholar",
        search_providers: ["semantic_scholar"],
        lexical_matched_query_families:
          lexicalFamiliesByPaper.get(row.paper_id) ?? [],
        semantic_review_selections: selections,
        semantic_review_requested_query_families:
          selections.map((selection) => selection.family_id),
        semantic_review_requested: selections.length > 0,
        selected_by_semantic_quality: retainedPaperIds.has(row.paper_id),
        published_in_corpus: retainedPaperIds.has(row.paper_id)
      });
    }).join("\n")}\n`,
    "utf8"
  );
  await persistCollectAttemptArchive({
    run: input.run,
    attemptId: input.collectAttemptId,
    status: "quality_gate_passed",
    phase: "collection",
    artifactPaths: [
      "collect_query_plan.json",
      "collect_corpus_quality.json",
      "collect_semantic_review_input.json",
      "collect_semantic_review.json",
      "collect_topic_discovery_candidates.jsonl",
      "corpus.jsonl"
    ]
  });
  const runContext = new RunContextMemory(input.run.memoryRefs.runContextPath);
  await runContext.put("collect_papers.current_generation_id", input.collectAttemptId);
  await runContext.put("collect_papers.active_attempt_id", null);
}

async function writeCandidatePriorCollectLineage(input: {
  run: RunRecord;
  sourceAttemptId: string;
  collectAttemptId: string;
  corpusRaw: string;
  candidateId: string;
  researchCycle: number;
}): Promise<string> {
  const runDir = path.join(".autolabos", "runs", input.run.id);
  const candidate: HypothesisCandidate = {
    id: input.candidateId,
    text: "Typed boundary tracing tests a falsifiable relation over structured records.",
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
    runId: input.run.id,
    researchCycle: input.researchCycle,
    generatedAt: "2026-07-28T08:30:00.000Z",
    asOfDate: "2026-07-28",
    sourceCorpus: {
      collect_attempt_id: input.sourceAttemptId,
      sha256: createHash("sha256").update(input.corpusRaw, "utf8").digest("hex"),
      byte_length: Buffer.byteLength(input.corpusRaw, "utf8")
    },
    candidates: [{
      candidate,
      candidateContract: buildPriorAbsorptionCandidateContract(candidate)
    }]
  });
  const firstCorpusRow = input.corpusRaw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstCorpusRow) {
    throw new Error("candidate_prior_fixture_requires_nonempty_corpus");
  }
  const selectedPaperId = (JSON.parse(firstCorpusRow) as { paper_id?: string }).paper_id;
  if (!selectedPaperId) {
    throw new Error("candidate_prior_fixture_requires_paper_id");
  }
  const candidateFamilyIds = plan.candidates.flatMap((candidatePlan) =>
    candidatePlan.families.map((family) => family.family_id)
  );
  const resultCorpusRaw = input.corpusRaw
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => {
      const row = JSON.parse(line) as Record<string, unknown> & { paper_id?: string };
      if (row.paper_id !== selectedPaperId) {
        return JSON.stringify(row);
      }
      const existingFamilies = Array.isArray(row.query_families)
        ? row.query_families.filter((value): value is string => typeof value === "string")
        : [];
      return JSON.stringify({
        ...row,
        query_families: [...new Set([...existingFamilies, ...candidateFamilyIds])].sort()
      });
    })
    .join("\n") + "\n";
  const receipt = buildCandidatePriorSearchReceipt({
    plan,
    collectAttemptId: input.collectAttemptId,
    generatedAt: "2026-07-28T08:35:00.000Z",
    resultCorpusSha256: createHash("sha256")
      .update(resultCorpusRaw, "utf8")
      .digest("hex"),
    resultCorpusByteLength: Buffer.byteLength(resultCorpusRaw, "utf8"),
    attempts: plan.candidates.flatMap((plannedCandidate) =>
      plannedCandidate.families.flatMap((family) =>
        family.lanes.map((lane) => ({
          familyId: family.family_id,
          retrievalLane: lane.retrieval_lane,
          query: family.query,
          fetched: 1,
          selected: 1,
          selectedPaperIds: [selectedPaperId]
        }))
      )
    )
  });
  const receiptValidation = validateCandidatePriorSearchReceipt(receipt, {
    plan,
    expectedCollectAttemptId: input.collectAttemptId,
    sourceCorpusRaw: input.corpusRaw,
    resultCorpusRaw
  });
  if (!receiptValidation.valid) {
    throw new Error(
      `candidate_prior_fixture_invalid:${input.researchCycle}:`
      + receiptValidation.reasons.join(",")
    );
  }
  const queryPlan = {
    collect_attempt_id: input.collectAttemptId,
    research_mode: "topic_discovery",
    strategy: "candidate_prior_portfolio",
    candidate_prior_search_plan: plan
  };
  await writeFile(
    path.join(runDir, "collect_generation.json"),
    JSON.stringify({
      version: 1,
      kind: "collect_generation",
      run_id: input.run.id,
      collect_attempt_id: input.collectAttemptId,
      started_at: "2026-07-28T08:34:00.000Z"
    }),
    "utf8"
  );
  await writeFile(
    path.join(runDir, "collect_query_plan.json"),
    JSON.stringify(queryPlan),
    "utf8"
  );
  await writeFile(
    path.join(runDir, "collect_candidate_prior_search_plan.json"),
    JSON.stringify(plan),
    "utf8"
  );
  await writeFile(
    path.join(runDir, "collect_candidate_prior_search_receipt.json"),
    JSON.stringify(receipt),
    "utf8"
  );
  await writeFile(path.join(runDir, "corpus.jsonl"), resultCorpusRaw, "utf8");
  await writeFile(
    path.join(runDir, "collect_result.json"),
    JSON.stringify({
      collect_attempt_id: input.collectAttemptId,
      completed: true,
      fetched: 1,
      stored: resultCorpusRaw.trim().split("\n").filter(Boolean).length
    }),
    "utf8"
  );
  await persistCollectAttemptArchive({
    run: input.run,
    attemptId: input.collectAttemptId,
    status: "quality_gate_passed",
    phase: "collection",
    artifactPaths: [
      "collect_query_plan.json",
      "collect_candidate_prior_search_plan.json",
      "collect_candidate_prior_search_receipt.json",
      "corpus.jsonl"
    ]
  });
  const runContext = new RunContextMemory(input.run.memoryRefs.runContextPath);
  await runContext.put("collect_papers.current_generation_id", input.collectAttemptId);
  await runContext.put("collect_papers.active_attempt_id", null);
  return resultCorpusRaw;
}

async function writeTopicDiscoveryBrief(run: RunRecord): Promise<void> {
  const rawBrief = [
    "# Research Brief",
    "",
    "## Research Mode",
    "topic_discovery",
    ""
  ].join("\n");
  const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
  await runContext.put("run_brief.raw", rawBrief);
  const briefDir = path.join(".autolabos", "runs", run.id, "brief");
  await mkdir(briefDir, { recursive: true });
  await writeFile(path.join(briefDir, "source_brief.md"), rawBrief, "utf8");
}

function completeTopicDiscoveryLineageFixture() {
  const families = [
    {
      queryFamily: "query_family_measurement",
      query: '"document retrieval" measurement reliability',
      axisTerms: ["measurement", "reliability"],
      lens: "Direct measurement of research reliability",
      contributionIntent: "measurement"
    },
    {
      queryFamily: "query_family_robustness",
      query: '"document retrieval" robustness evaluation',
      axisTerms: ["robustness", "evaluation"],
      lens: "Direct evaluation of research robustness",
      contributionIntent: "empirical_finding"
    }
  ];
  const rows = families.flatMap((family, familyIndex) =>
    Array.from({ length: 4 }, (_, paperIndex) => ({
      paper_id: `paper_${familyIndex + 1}_${paperIndex + 1}`,
      title: `Document retrieval ${family.axisTerms.join(" ")} study ${paperIndex + 1}`,
      abstract: `Direct evidence for ${family.lens.toLowerCase()}.`,
      query_families: [family.queryFamily]
    }))
  );
  return { families, rows };
}

function overwriteCorpusSync(runId: string, rows: unknown[]): void {
  const dir = path.join(".autolabos", "runs", runId);
  writeFileSync(path.join(dir, "corpus.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function overwriteCollectEnrichmentSync(runId: string, entries: unknown[]): void {
  const dir = path.join(".autolabos", "runs", runId);
  writeFileSync(
    path.join(dir, "collect_enrichment.jsonl"),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    "utf8"
  );
}

function overwriteCollectResultSync(runId: string, value: unknown): void {
  const dir = path.join(".autolabos", "runs", runId);
  writeFileSync(path.join(dir, "collect_result.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeCachedPaperTextSync(runId: string, paperId: string, text: string): void {
  const cacheDir = path.join(".autolabos", "runs", runId, "analysis_cache", "texts");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(path.join(cacheDir, `${paperId}.v3.txt`), text, "utf8");
}

function writeCachedPageImagesSync(runId: string, paperId: string, count: number): void {
  const cacheDir = path.join(".autolabos", "runs", runId, "analysis_cache", "page_images", paperId);
  mkdirSync(cacheDir, { recursive: true });
  for (let index = 1; index <= count; index += 1) {
    writeFileSync(path.join(cacheDir, `page-${String(index).padStart(3, "0")}.png`), "png");
  }
}

function jsonOutput(summary: string, claim: string): string {
  return JSON.stringify({
    summary,
    key_findings: [`finding ${claim}`],
    limitations: [`limitation ${claim}`],
    datasets: [`dataset ${claim}`],
    metrics: [`metric ${claim}`],
    novelty: `novelty ${claim}`,
    reproducibility_notes: [`repro ${claim}`],
    evidence_items: [
      {
        claim,
        method_slot: `method ${claim}`,
        result_slot: `result ${claim}`,
        limitation_slot: `limitation ${claim}`,
        dataset_slot: `dataset ${claim}`,
        metric_slot: `metric ${claim}`,
        evidence_span: `span ${claim}`,
        confidence: 0.7
      }
    ]
  });
}

function topicMeasurementContract() {
  return {
    primary_metric: "primary_score",
    metric_unit: "unitless",
    metric_scale: "raw" as const,
    metric_direction: "maximize" as const,
    effect_criterion: {
      basis: "delta_vs_reference" as const,
      magnitude: 0.05,
      scale: "raw" as const,
      inclusive: true
    },
    meaningful_effect: "At least 0.05 over the declared comparator.",
    measurement_signals: ["primary_score", "uncertainty_interval"],
    measurement_hint: "Compare the primary score with uncertainty across repeated matched runs.",
    gap_statement: "Prior evaluations omit an independently matched context.",
    closest_prior_non_overlap: "The candidate measures a boundary absent from the linked prior work.",
    reviewer_absorption_objection: "A reviewer may absorb the candidate into the strongest matched comparator.",
    comparator: "Matched-budget comparator",
    dataset_task_bench: "evaluation_fixture",
    falsifier: "The prespecified interval includes the null margin.",
    local_budget: makeTopicProbeComputeBudgetDeclaration(),
    kill_signal: "Stop if the comparator cannot execute or the effect misses the prespecified floor.",
    contribution_claim: "The comparison identifies a prespecified boundary absent from the closest priors.",
    minimum_publishable_evidence: "Repeated comparisons with uncertainty intervals and failure analysis."
  };
}

function hypothesisPipelineOutputs(evidenceId = "ev_p1_1"): string[] {
  return [
    JSON.stringify({
      summary: "Mapped evidence into one intervention axis.",
      axes: [
        {
          id: "ax_1",
          label: "Execution feedback",
          mechanism: "Validator-backed correction reduces downstream errors.",
          intervention: "Add bounded execute-test-repair loops.",
          evidence_links: [evidenceId]
        }
      ]
    }),
    JSON.stringify({
      summary: "Generated mechanism drafts.",
      candidates: [
        {
          text: "Validator-backed repair loops will reduce failure variance across repeated runs.",
          novelty: 4,
          feasibility: 4,
          testability: 5,
          cost: 2,
          expected_gain: 5,
          evidence_links: [evidenceId],
          axis_ids: ["ax_1"],
          rationale: "Directly operationalizes the recovered evidence.",
          ...topicMeasurementContract()
        }
      ]
    }),
    JSON.stringify({
      summary: "Generated contradiction drafts.",
      candidates: [
        {
          text: "Repair loops help less when tasks already have deterministic validators.",
          novelty: 3,
          feasibility: 4,
          testability: 3,
          cost: 2,
          expected_gain: 2,
          evidence_links: [evidenceId],
          axis_ids: ["ax_1"],
          rationale: "Captures a plausible boundary condition.",
          ...topicMeasurementContract()
        }
      ]
    }),
    JSON.stringify({
      summary: "Generated intervention drafts.",
      candidates: [
        {
          text: "Batched execute-test-repair loops will improve reproducibility more than discussion-only retries.",
          novelty: 4,
          feasibility: 5,
          testability: 5,
          cost: 2,
          expected_gain: 5,
          evidence_links: [evidenceId],
          axis_ids: ["ax_1"],
          rationale: "Turns evidence into a concrete, testable intervention.",
          ...topicMeasurementContract()
        }
      ]
    }),
    JSON.stringify({
      summary: "Selected the strongest drafts.",
      reviews: [
        {
          candidate_id: "mechanism_1",
          keep: true,
          groundedness: 5,
          causal_clarity: 5,
          falsifiability: 5,
          experimentability: 5,
          measurement_specificity: 4,
          measurement_signals: ["repeatability"],
          measurement_hint: "Measure repeated-run failure variance on the repaired benchmark.",
          limitation_reflection: 4,
          measurement_readiness: 5,
          strengths: ["Directly tied to the evidence."],
          weaknesses: ["Needs benchmark scoping."],
          critique_summary: "Strong."
        },
        {
          candidate_id: "contradiction_1",
          keep: false,
          groundedness: 3,
          causal_clarity: 3,
          falsifiability: 3,
          experimentability: 2,
          measurement_specificity: 2,
          measurement_signals: [],
          limitation_reflection: 2,
          measurement_readiness: 1,
          strengths: ["Reasonable boundary condition."],
          weaknesses: ["Less actionable."],
          critique_summary: "Too weak for top selection."
        },
        {
          candidate_id: "intervention_1",
          keep: true,
          groundedness: 5,
          causal_clarity: 5,
          falsifiability: 5,
          experimentability: 5,
          measurement_specificity: 5,
          measurement_signals: ["repeated runs", "variance reduction"],
          measurement_hint: "Compare repeated-run variance against discussion-only retries.",
          limitation_reflection: 4,
          measurement_readiness: 5,
          strengths: ["Highly testable."],
          weaknesses: ["Adds execution cost."],
          critique_summary: "Excellent."
        }
      ]
    })
  ];
}

describe("analyzePapers node", () => {
  it("pauses for manual review when no collected corpus rows are available", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-empty-corpus-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-empty-corpus";
    const run = makeRun(runId);
    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        analysis: {
          responses_model: "gpt-5.4"
        },
        papers: {
          max_results: 200
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm: new SequenceJsonLLM([jsonOutput("summary", "claim")]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    expect(result.needsApproval).toBe(true);
    expect(result.summary).toContain("no collected corpus rows are currently available");
    expect(result.transitionRecommendation?.action).toBe("pause_for_human");
    expect(result.transitionRecommendation?.reason).toContain("corpus.jsonl is currently missing or empty");
    expect(result.transitionRecommendation?.suggestedCommands).toContain(
      `/agent collect --limit 200 --run ${run.id}`
    );
    expect(result.transitionRecommendation?.suggestedCommands).toContain(`/agent run collect_papers ${run.id}`);

    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(
      loggedTexts.some((text) => text.includes("No corpus rows are available for analyze_papers"))
    ).toBe(true);
  });

  it("writes structured summaries, evidence, and manifest for analyzed papers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-success";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      { paper_id: "p1", title: "Paper 1", abstract: "Abstract 1 references Table 1 and Figure 2.", authors: ["Alice"] },
      { paper_id: "p2", title: "Paper 2", abstract: "Abstract 2", authors: ["Bob"] }
    ]);

    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        providers: {
          llm_mode: "openai_api",
          openai: {
            model: "gpt-5.4",
            reasoning_effort: "high"
          }
        },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm: new SequenceJsonLLM([jsonOutput("summary 1", "claim 1"), jsonOutput("summary 2", "claim 2")]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    expect(result.needsApproval).toBe(true);

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    const evidenceRaw = await readFile(path.join(".autolabos", "runs", runId, "evidence_store.jsonl"), "utf8");
    const manifestRaw = await readFile(path.join(".autolabos", "runs", runId, "analysis_manifest.json"), "utf8");
    const gapMapRaw = await readFile(
      path.join(".autolabos", "runs", runId, "analysis", "gap_map.json"),
      "utf8"
    );
    const manifest = JSON.parse(manifestRaw);
    const gapMap = JSON.parse(gapMapRaw) as {
      gaps: Array<{ epistemic_status?: string }>;
      gates: Array<{ code?: string; status?: string }>;
    };

    expect(summariesRaw).toContain('"source_type":"abstract"');
    expect(summariesRaw).toContain('"summary":"summary 1"');
    expect(evidenceRaw).toContain('"claim":"claim 1"');
    expect(gapMap.gaps).toHaveLength(2);
    expect(gapMap.gaps.every((gap) => gap.epistemic_status === "provisional_candidate")).toBe(true);
    expect(
      gapMap.gates.find((gate) => gate.code === "independent_gap_support_present")?.status
    ).toBe("block");
    expect(manifestRaw).toContain('"status": "completed"');
    expect(manifest.papers.p1.table_reference_count).toBe(1);
    expect(manifest.papers.p1.figure_reference_count).toBe(1);
    expect(manifest.papers.p1.has_table_references).toBe(true);
    expect(manifest.papers.p1.has_figure_references).toBe(true);
    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(loggedTexts.some((text) => text.includes('Resolving analysis source 1/2 for "Paper 1".'))).toBe(true);
    expect(loggedTexts.some((text) => text.includes('[p1] Starting LLM analysis attempt 1/2.'))).toBe(true);
    expect(loggedTexts.some((text) => text.includes('Persisted analysis outputs for "Paper 1"'))).toBe(true);
    expect(loggedTexts.some((text) => text.includes('Analyzed "Paper 1" (1 evidence item(s), source=abstract).'))).toBe(true);
  });

  it("refreshes runs.json while analysis progress is persisted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-runstore-"));
    tempDirs.push(root);
    process.chdir(root);

    const paths = resolveAppPaths(root);
    await ensureScaffold(paths);
    const runStore = new RunStore(paths);
    const run = await runStore.createRun({
      title: "Multi-Agent Collaboration",
      topic: "Multi-Agent Collaboration",
      constraints: [],
      objectiveMetric: "primary_score >= 0.9"
    });
    run.status = "running";
    run.currentNode = "analyze_papers";
    run.graph.currentNode = "analyze_papers";
    run.graph.nodeStates.analyze_papers = {
      status: "running",
      updatedAt: new Date().toISOString()
    };
    await runStore.updateRun(run);

    await writeCorpus(run.id, [
      { paper_id: "p1", title: "Paper 1", abstract: "Abstract 1", authors: ["Alice"] }
    ]);

    const initialRunsRaw = await readFile(paths.runsFile, "utf8");
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore,
      eventStream: new InMemoryEventStream(),
      llm: new SequenceJsonLLM([jsonOutput("summary 1", "claim 1")]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    await node.execute({ run, graph: run.graph });

    const nextRunsRaw = await readFile(paths.runsFile, "utf8");
    expect(nextRunsRaw).not.toBe(initialRunsRaw);

    const runsFile = JSON.parse(nextRunsRaw) as { runs: RunRecord[] };
    const updated = runsFile.runs.find((candidate) => candidate.id === run.id);
    expect(updated?.latestSummary).toContain("1 evidence item(s)");
    expect(updated?.graph.nodeStates.analyze_papers.note).toContain("1 evidence item(s)");
  });

  it("updates runs.json to an analyze-start summary before a long rerank finishes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-start-summary-"));
    tempDirs.push(root);
    process.chdir(root);

    const paths = resolveAppPaths(root);
    await ensureScaffold(paths);
    const runStore = new RunStore(paths);
    const run = await runStore.createRun({
      title: "Tabular Baseline Benchmarking",
      topic: "Tabular Baseline Benchmarking",
      constraints: [],
      objectiveMetric: "primary_score >= 0.9"
    });
    run.status = "running";
    run.currentNode = "analyze_papers";
    run.graph.currentNode = "analyze_papers";
    run.graph.nodeStates.analyze_papers = {
      status: "running",
      updatedAt: new Date().toISOString()
    };
    await runStore.updateRun(run);

    await writeCorpus(
      run.id,
      Array.from({ length: 35 }, (_, index) => ({
        paper_id: `p${index + 1}`,
        title: `Paper ${index + 1}`,
        abstract: `Abstract ${index + 1}`,
        authors: [`Author ${index + 1}`]
      }))
    );

    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore,
      eventStream: new InMemoryEventStream(),
      llm: new RerankHangingLLM(),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const abortController = new AbortController();
    const execution = node.execute({ run, graph: run.graph, abortSignal: abortController.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const runsFile = JSON.parse(await readFile(paths.runsFile, "utf8")) as { runs: RunRecord[] };
    const updated = runsFile.runs.find((candidate) => candidate.id === run.id);
    expect(updated?.latestSummary).toContain("analyze_papers has started");
    expect(updated?.latestSummary).toContain("select top 30");
    expect(updated?.graph.nodeStates.analyze_papers.note).toContain("analyze_papers has started");

    abortController.abort();
    await expect(execution).rejects.toThrow(/aborted/i);
  });

  it("marks a selected paper as running in analysis_manifest before llm analysis completes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-manifest-running-"));
    tempDirs.push(root);
    process.chdir(root);

    const paths = resolveAppPaths(root);
    await ensureScaffold(paths);
    const runStore = new RunStore(paths);
    const run = await runStore.createRun({
      title: "Budgeted Reasoning",
      topic: "Budgeted Reasoning",
      constraints: [],
      objectiveMetric: "primary_score >= 0.9"
    });
    run.status = "running";
    run.currentNode = "analyze_papers";
    run.graph.currentNode = "analyze_papers";
    run.graph.nodeStates.analyze_papers = {
      status: "running",
      updatedAt: new Date().toISOString()
    };
    await runStore.updateRun(run);

    await writeCorpus(run.id, [
      { paper_id: "p1", title: "Paper 1", abstract: "Abstract 1", authors: ["Alice"] }
    ]);

    class ManifestCheckingLlm extends MockLLMClient {
      override async complete(_prompt: string): Promise<{ text: string }> {
        const manifestRaw = await readFile(path.join(".autolabos", "runs", run.id, "analysis_manifest.json"), "utf8");
        const manifest = JSON.parse(manifestRaw) as {
          papers?: Record<string, { status?: string }>;
        };
        expect(manifest.papers?.p1?.status).toBe("running");
        return { text: jsonOutput("summary 1", "claim 1") };
      }
    }

    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore,
      eventStream: new InMemoryEventStream(),
      llm: new ManifestCheckingLlm(),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
  });

  it("keeps completed artifacts when post-persist run summary refresh fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-post-persist-refresh-"));
    tempDirs.push(root);
    process.chdir(root);
    await seedCodexOAuthHome(root);

    const runId = "run-analyze-post-persist-refresh";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      { paper_id: "p1", title: "Paper 1", abstract: "Abstract 1", authors: ["Alice"] }
    ]);

    let getRunCalls = 0;
    const runStore = {
      async getRun(id: string) {
        getRunCalls += 1;
        if (getRunCalls <= 2) {
          return { ...run, id };
        }
        throw new Error("Unexpected end of JSON input");
      },
      async updateRun() {
        return;
      }
    };

    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        providers: makeCodexProviderConfig(),
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: runStore as any,
      eventStream,
      llm: new SequenceJsonLLM([jsonOutput("summary 1", "claim 1")]),
      codex: makeCodexReadyStub(),
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    const evidenceRaw = await readFile(path.join(".autolabos", "runs", runId, "evidence_store.jsonl"), "utf8");
    const manifestRaw = await readFile(path.join(".autolabos", "runs", runId, "analysis_manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw);

    expect(summariesRaw.trim().split("\n")).toHaveLength(1);
    expect(evidenceRaw.trim().split("\n")).toHaveLength(1);
    expect(manifest.papers.p1.status).toBe("completed");

    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(
      loggedTexts.some((text) =>
        text.includes('Post-persist run summary refresh failed after writing artifacts for "Paper 1": Unexpected end of JSON input')
      )
    ).toBe(true);
    expect(loggedTexts.some((text) => text.includes('Persisted analysis outputs for "Paper 1"'))).toBe(true);
  });

  it("persists partial progress and resumes only unfinished papers on rerun", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-resume-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-resume";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      { paper_id: "p1", title: "Paper 1", abstract: "Abstract 1", authors: ["Alice"] },
      { paper_id: "p2", title: "Paper 2", abstract: "Abstract 2", authors: ["Bob"] }
    ]);

    const firstNode = createAnalyzePapersNode({
      config: {
        providers: {
          llm_mode: "openai_api",
          openai: {
            model: "gpt-5.4",
            chat_model: "gpt-5.4",
            reasoning_effort: "medium"
          }
        },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequenceJsonLLM([jsonOutput("summary 1", "claim 1"), "invalid-json"]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const first = await firstNode.execute({ run, graph: run.graph });
    expect(first.status).toBe("success");
    expect(first.needsApproval).toBe(true);
    expect(first.transitionRecommendation?.action).toBe("pause_for_human");
    expect(first.transitionRecommendation?.targetNode).toBeUndefined();
    expect(first.transitionRecommendation?.suggestedCommands).not.toEqual(
      expect.arrayContaining([expect.stringContaining("generate_hypotheses")])
    );
    expect(first.summary).toContain("Preserved partial analysis");

    const summariesAfterFirst = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    expect(summariesAfterFirst.trim().split("\n")).toHaveLength(1);
    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    expect(await runContext.get("analyze_papers.summary_count")).toBe(1);
    expect(await runContext.get("analyze_papers.evidence_count")).toBe(1);

    const secondNode = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequenceJsonLLM([jsonOutput("summary 2", "claim 2")]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const second = await secondNode.execute({ run, graph: run.graph });
    expect(second.status).toBe("success");

    const summariesAfterSecond = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    const evidenceAfterSecond = await readFile(path.join(".autolabos", "runs", runId, "evidence_store.jsonl"), "utf8");

    expect(summariesAfterSecond.trim().split("\n")).toHaveLength(2);
    expect(evidenceAfterSecond.trim().split("\n")).toHaveLength(2);
    expect(summariesAfterSecond.match(/"paper_id":"p1"/g)?.length).toBe(1);
    expect(summariesAfterSecond.match(/"paper_id":"p2"/g)?.length).toBe(1);
  });

  it("continues after an extractor timeout when abstract fallback still persists outputs", async () => {
    process.env.AUTOLABOS_ANALYSIS_EXTRACT_TIMEOUT_MS = "10";

    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-extract-timeout-"));
    tempDirs.push(root);
    process.chdir(root);
    await seedCodexOAuthHome(root);

    const runId = "run-analyze-extract-timeout";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      { paper_id: "p1", title: "Paper 1", abstract: "Abstract 1", authors: ["Alice"] },
      { paper_id: "p2", title: "Paper 2", abstract: "Abstract 2", authors: ["Bob"] }
    ]);

    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        providers: makeCodexProviderConfig(),
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm: new TitleSelectiveHangingExtractorLLM({
        hangingTitle: "Paper 2",
        summary: "summary 1",
        claim: "claim 1"
      }),
      codex: makeCodexReadyStub(),
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
    expect(result.needsApproval).toBe(true);
    expect(result.transitionRecommendation).toBeUndefined();

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    const evidenceRaw = await readFile(path.join(".autolabos", "runs", runId, "evidence_store.jsonl"), "utf8");
    expect(summariesRaw.trim().split("\n")).toHaveLength(2);
    expect(evidenceRaw.trim().split("\n")).toHaveLength(2);

    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(loggedTexts.some((text) => text.includes("extractor exceeded the 10ms timeout"))).toBe(true);
    expect(loggedTexts.some((text) => text.includes('Persisted analysis outputs for "Paper 1"'))).toBe(true);
    expect(
      loggedTexts.some((text) =>
        text.includes("Abstract-only analysis still timed out. Using a deterministic abstract fallback analysis")
      )
    ).toBe(true);
    expect(loggedTexts.some((text) => text.includes('Persisted analysis outputs for "Paper 2"'))).toBe(true);
  });

  it("preserves partial artifacts when the corpus regresses but the selection request is unchanged", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-selection-regression-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-selection-regression";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      { paper_id: "p1", title: "Paper 1", abstract: "Abstract 1", authors: ["Alice"] }
    ]);

    const firstNode = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequenceJsonLLM([jsonOutput("summary 1", "claim 1")]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const first = await firstNode.execute({ run, graph: run.graph });
    expect(first.status).toBe("success");

    await writeFile(path.join(".autolabos", "runs", runId, "corpus.jsonl"), "", "utf8");

    const eventStream = new InMemoryEventStream();
    const secondNode = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm: new SequenceJsonLLM(["should-not-be-used"]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const second = await secondNode.execute({ run, graph: run.graph });
    expect(second.status).toBe("success");
    expect(second.needsApproval).toBe(true);
    expect(second.summary).toContain("Preserving 1 summary row(s) and 1 evidence row(s)");
    expect(second.transitionRecommendation?.action).toBe("pause_for_human");

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    const evidenceRaw = await readFile(path.join(".autolabos", "runs", runId, "evidence_store.jsonl"), "utf8");
    expect(summariesRaw.trim().split("\n")).toHaveLength(1);
    expect(evidenceRaw.trim().split("\n")).toHaveLength(1);

    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    expect(await runContext.get("analyze_papers.summary_count")).toBe(1);
    expect(await runContext.get("analyze_papers.evidence_count")).toBe(1);
    expect(await runContext.get("analyze_papers.selected_count")).toBe(1);

    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(loggedTexts.some((text) => text.includes("Preserving 1 summary row(s) and 1 evidence row(s)"))).toBe(true);
    expect(loggedTexts.some((text) => text.includes("Resetting summaries/evidence"))).toBe(false);
  });

  it("blocks stale analysis reuse when the latest collection generation failed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-collect-lineage-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-collect-lineage";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      {
        paper_id: "paper-prior",
        title: "Prior configured paper",
        abstract: "Prior configured abstract",
        authors: ["Prior Author"]
      }
    ]);
    const firstNode = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: { responses_model: "gpt-5.4" }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequenceJsonLLM([jsonOutput("prior summary", "prior claim")]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });
    expect((await firstNode.execute({ run, graph: run.graph })).status).toBe("success");

    const runDir = path.join(".autolabos", "runs", runId);
    const priorSummaries = await readFile(path.join(runDir, "paper_summaries.jsonl"), "utf8");
    const priorEvidence = await readFile(path.join(runDir, "evidence_store.jsonl"), "utf8");
    await writeFile(path.join(runDir, "corpus.jsonl"), "", "utf8");
    const failedAttemptId = "20260102030405678-failedattempt";
    await writeFile(
      path.join(runDir, "collect_generation.json"),
      JSON.stringify({
        version: 1,
        kind: "collect_generation",
        run_id: runId,
        collect_attempt_id: failedAttemptId,
        started_at: new Date().toISOString()
      }),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "collect_result.json"),
      JSON.stringify({
        collect_attempt_id: failedAttemptId,
        completed: false,
        stored: 0,
        fetchError: "configured collection failed"
      }),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "collect_attempt_manifest.json"),
      JSON.stringify({
        version: 2,
        kind: "collect_attempt_archive",
        collect_attempt_id: failedAttemptId,
        run_id: runId,
        status: "collection_failed",
        phase: "collection",
        revision_id: "collection-failed",
        files: []
      }),
      "utf8"
    );
    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    await runContext.put("collect_papers.current_generation_id", failedAttemptId);
    await runContext.put("collect_papers.active_attempt_id", null);

    const llm = new CountingJsonLLM(["should-not-be-used"]);
    const secondNode = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: { responses_model: "gpt-5.4" }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });
    const result = await secondNode.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.needsApproval).not.toBe(true);
    expect(result.error).toContain("collect_lineage_result_incomplete");
    expect(result.error).toContain("collect_lineage_quality_gate_not_passed");
    expect(llm.callCount).toBe(0);
    expect(await readFile(path.join(runDir, "paper_summaries.jsonl"), "utf8")).toBe(priorSummaries);
    expect(await readFile(path.join(runDir, "evidence_store.jsonl"), "utf8")).toBe(priorEvidence);
    const gate = JSON.parse(
      await readFile(path.join(runDir, "analysis", "collect_lineage_gate.json"), "utf8")
    ) as { valid?: boolean; collect_attempt_id?: string; reasons?: string[] };
    expect(gate).toMatchObject({
      valid: false,
      collect_attempt_id: failedAttemptId,
      reasons: expect.arrayContaining([
        "collect_lineage_result_incomplete",
        "collect_lineage_result_failed",
        "collect_lineage_quality_gate_not_passed"
      ])
    });
  });

  it("fails closed for an authoritative topic-discovery brief when every lineage sidecar is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-missing-topic-lineage-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-missing-topic-lineage";
    const run = makeRun(runId);
    const fixture = completeTopicDiscoveryLineageFixture();
    await writeCorpus(runId, fixture.rows);
    await writeTopicDiscoveryCollectLineage({
      run,
      collectAttemptId: "collect-attempt-missing-topic-lineage",
      ...fixture
    });
    await writeTopicDiscoveryBrief(run);
    const runDir = path.join(".autolabos", "runs", runId);
    const collectResultPath = path.join(runDir, "collect_result.json");
    const collectResult = JSON.parse(
      await readFile(collectResultPath, "utf8")
    ) as Record<string, unknown>;
    delete collectResult.corpusQuality;
    await writeFile(collectResultPath, JSON.stringify(collectResult), "utf8");
    await Promise.all([
      "collect_query_plan.json",
      "collect_corpus_quality.json",
      "collect_semantic_review_input.json",
      "collect_semantic_review.json",
      "collect_topic_discovery_candidates.jsonl"
    ].map((fileName) => rm(path.join(runDir, fileName), { force: true })));

    const llm = new CountingJsonLLM([jsonOutput("unused", "unused")]);
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: { responses_model: "gpt-5.4" }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("collect_lineage_topic_query_plan_mode_mismatch");
    expect(result.error).toContain("collect_lineage_topic_family_quality_missing");
    expect(result.error).toContain("collect_lineage_topic_semantic_review_input_invalid");
    expect(result.error).toContain("collect_lineage_topic_semantic_review_not_complete");
    expect(llm.callCount).toBe(0);
    const modeGuard = JSON.parse(
      await readFile(path.join(runDir, "governance", "research_mode_guard.json"), "utf8")
    ) as { effectiveMode?: string; valid?: boolean };
    expect(modeGuard).toMatchObject({ effectiveMode: "topic_discovery", valid: true });
  });

  it("accepts two qualifying families while preserving a weak family as diagnostic", async () => {
    const root = await mkdtemp(path.join(
      tmpdir(),
      "autolabos-analyze-minimum-qualified-families-"
    ));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-minimum-qualified-families";
    const run = makeRun(runId);
    const families = [
      {
        queryFamily: "query_family_generation",
        query: '"document retrieval" controlled generation',
        axisTerms: ["controlled", "generation"],
        lens: "Controlled generation over retrieved documents",
        contributionIntent: "method"
      },
      {
        queryFamily: "query_family_synthesis",
        query: '"document retrieval" structured synthesis',
        axisTerms: ["structured", "synthesis"],
        lens: "Structured synthesis over retrieved documents",
        contributionIntent: "method"
      },
      {
        queryFamily: "query_family_resolution",
        query: '"document retrieval" disagreement resolution',
        axisTerms: ["disagreement", "resolution"],
        lens: "Resolution of disagreements over retrieved documents",
        contributionIntent: "empirical_finding"
      }
    ];
    const candidateRows = families.flatMap((family, familyIndex) =>
      Array.from({ length: 8 }, (_, paperIndex) => ({
        paper_id: `paper_${familyIndex + 1}_${paperIndex + 1}`,
        title:
          `Document retrieval ${family.axisTerms.join(" ")} evidence `
          + `${paperIndex + 1}`,
        abstract:
          `Document retrieval ${family.axisTerms.join(" ")} is the central `
          + "controlled relation.",
        query_families: [family.queryFamily]
      }))
    );
    const reviewedPairs = candidateRows.map((row, index) => {
      const familyIndex = Math.floor(index / 8);
      const withinFamilyIndex = index % 8;
      return {
        paper_id: row.paper_id,
        family_id: row.query_families[0]!,
        verdict: familyIndex < 2
          ? withinFamilyIndex < 5
            ? "direct_support" as const
            : "application_only" as const
          : withinFamilyIndex < 3
            ? "direct_support" as const
            : "uncertain" as const
      };
    });
    const retainedRows = candidateRows.filter((_, index) =>
      Math.floor(index / 8) < 2 && index % 8 < 5
    );
    await writeCorpus(runId, retainedRows);
    await writeTopicDiscoveryCollectLineage({
      run,
      collectAttemptId: "collect-attempt-minimum-qualified-families",
      rows: retainedRows,
      candidateRows,
      families,
      reviewedPairs
    });
    await writeTopicDiscoveryBrief(run);

    const llm = new CountingJsonLLM(
      Array.from({ length: 20 }, () => "invalid-json")
    );
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "ollama" }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(llm.callCount, result.error).toBeGreaterThan(0);
    expect(result.error ?? "").not.toContain("collect_lineage_");
    const gate = JSON.parse(await readFile(
      path.join(
        ".autolabos",
        "runs",
        runId,
        "analysis",
        "collect_lineage_gate.json"
      ),
      "utf8"
    )) as {
      valid?: boolean;
      reasons?: string[];
    };
    expect(gate).toMatchObject({ valid: true, reasons: [] });
    const quality = JSON.parse(await readFile(
      path.join(
        ".autolabos",
        "runs",
        runId,
        "collect_corpus_quality.json"
      ),
      "utf8"
    )) as {
      query_families?: Array<{
        query_family?: string;
        qualifies_for_coverage?: boolean;
        retained_paper_count?: number;
      }>;
    };
    expect(quality.query_families).toEqual(expect.arrayContaining([
      expect.objectContaining({
        query_family: "query_family_generation",
        qualifies_for_coverage: true,
        retained_paper_count: 5
      }),
      expect.objectContaining({
        query_family: "query_family_synthesis",
        qualifies_for_coverage: true,
        retained_paper_count: 5
      }),
      expect.objectContaining({
        query_family: "query_family_resolution",
        qualifies_for_coverage: false,
        retained_paper_count: 0
      })
    ]));
  });

  it("validates two candidate-prior augmentations back to the original semantic audit", async () => {
    const root = await mkdtemp(path.join(
      tmpdir(),
      "autolabos-analyze-recursive-candidate-prior-"
    ));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-recursive-candidate-prior";
    const run = makeRun(runId);
    const fixture = completeTopicDiscoveryLineageFixture();
    const baseAttemptId = "collect-attempt-topic-base";
    const firstCandidateAttemptId = "collect-attempt-candidate-prior-first";
    const secondCandidateAttemptId = "collect-attempt-candidate-prior-second";
    await writeCorpus(runId, fixture.rows);
    await writeTopicDiscoveryCollectLineage({
      run,
      collectAttemptId: baseAttemptId,
      ...fixture
    });
    await writeTopicDiscoveryBrief(run);
    const runDir = path.join(".autolabos", "runs", runId);
    const corpusRaw = await readFile(path.join(runDir, "corpus.jsonl"), "utf8");
    const firstCandidateCorpusRaw = await writeCandidatePriorCollectLineage({
      run,
      sourceAttemptId: baseAttemptId,
      collectAttemptId: firstCandidateAttemptId,
      corpusRaw,
      candidateId: "candidate_first",
      researchCycle: 0
    });
    await writeCandidatePriorCollectLineage({
      run,
      sourceAttemptId: firstCandidateAttemptId,
      collectAttemptId: secondCandidateAttemptId,
      corpusRaw: firstCandidateCorpusRaw,
      candidateId: "candidate_second",
      researchCycle: 1
    });

    const llm = new CountingJsonLLM(
      Array.from({ length: 20 }, () => "invalid-json")
    );
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "ollama" }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(llm.callCount, result.error).toBeGreaterThan(0);
    expect(result.error ?? "").not.toContain("collect_lineage_");
    const gate = JSON.parse(await readFile(
      path.join(runDir, "analysis", "collect_lineage_gate.json"),
      "utf8"
    )) as { valid?: boolean; collect_attempt_id?: string; reasons?: string[] };
    expect(gate).toMatchObject({
      valid: true,
      collect_attempt_id: secondCandidateAttemptId,
      reasons: []
    });
  });

  it.each([
    {
      caseId: "artifact-version",
      overrides: {
        version: TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT.version - 1
      }
    },
    {
      caseId: "term-normalization",
      overrides: {
        term_normalization_version:
          TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT.term_normalization_version + 1
      }
    },
    {
      caseId: "candidate-recall-semantics",
      overrides: {
        candidate_recall_semantics_version:
          TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT.candidate_recall_semantics_version + 1
      }
    }
  ])("fails closed when the topic-discovery query-plan $caseId is stale", async ({
    caseId,
    overrides
  }) => {
    const root = await mkdtemp(path.join(
      tmpdir(),
      `autolabos-analyze-query-plan-${caseId}-`
    ));
    tempDirs.push(root);
    process.chdir(root);

    const runId = `run-analyze-query-plan-${caseId}`;
    const run = makeRun(runId);
    const fixture = completeTopicDiscoveryLineageFixture();
    await writeCorpus(runId, fixture.rows);
    await writeTopicDiscoveryCollectLineage({
      run,
      collectAttemptId: `collect-attempt-query-plan-${caseId}`,
      queryPlanContractOverrides: overrides,
      ...fixture
    });
    await writeTopicDiscoveryBrief(run);

    const llm = new CountingJsonLLM(["unused"]);
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "ollama" }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain(
      "collect_lineage_topic_query_plan_semantics_unsupported"
    );
    expect(llm.callCount).toBe(0);
  });

  it("accepts provider-provenance semantic candidates without relabeling them as lexical matches", async () => {
    const root = await mkdtemp(path.join(
      tmpdir(),
      "autolabos-analyze-provider-provenance-lineage-"
    ));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-provider-provenance-lineage";
    const run = makeRun(runId);
    const fixture = completeTopicDiscoveryLineageFixture();
    const rows = fixture.rows.map((row, index) => ({
      ...row,
      title: `Document retrieval controlled comparison study ${index + 1}`,
      abstract: "The study directly examines calibration consistency under bounded evidence.",
      authors: [],
      lexical_query_families: []
    }));
    const reviewedPairs = rows.map((row) => ({
      paper_id: row.paper_id,
      family_id: row.query_families[0]!,
      selection_source: "provider_provenance_floor" as const
    }));
    await writeCorpus(runId, rows);
    await writeTopicDiscoveryCollectLineage({
      run,
      collectAttemptId: "collect-attempt-provider-provenance-lineage",
      rows,
      candidateRows: rows,
      families: fixture.families,
      reviewedPairs
    });
    await writeTopicDiscoveryBrief(run);

    const llm = new CountingJsonLLM(
      Array.from({ length: 20 }, () => "invalid-json")
    );
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "ollama" }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(llm.callCount, result.error).toBeGreaterThan(0);
    expect(result.error ?? "").not.toContain(
      "collect_lineage_topic_family_quality_observed_mismatch"
    );
  });

  it("rejects a one-family v5 artifact that lowers its own topic-discovery thresholds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-lowered-topic-thresholds-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-lowered-topic-thresholds";
    const run = makeRun(runId);
    const family = {
      queryFamily: "query_family_measurement",
      query: '"configured research" measurement reliability',
      axisTerms: ["measurement", "reliability"],
      lens: "Direct measurement of research reliability",
      contributionIntent: "measurement"
    };
    const rows = Array.from({ length: 2 }, (_, index) => ({
      paper_id: `paper_measurement_${index + 1}`,
      title: `Configured research measurement reliability study ${index + 1}`,
      abstract: "Direct evidence for measurement reliability.",
      query_families: [family.queryFamily]
    }));
    await writeCorpus(runId, rows);
    await writeTopicDiscoveryCollectLineage({
      run,
      collectAttemptId: "collect-attempt-lowered-topic-thresholds",
      rows,
      families: [family]
    });
    await writeTopicDiscoveryBrief(run);
    const qualityPath = path.join(
      ".autolabos",
      "runs",
      runId,
      "collect_corpus_quality.json"
    );
    const quality = JSON.parse(await readFile(qualityPath, "utf8")) as {
      thresholds?: Record<string, number>;
    };
    Object.assign(quality.thresholds ?? {}, {
      minimum_relevant_papers: 1,
      minimum_covered_query_families: 1,
      minimum_relevant_papers_per_family: 1,
      minimum_direct_support_per_family: 1,
      minimum_semantic_precision_per_family: 0
    });
    await writeFile(qualityPath, JSON.stringify(quality), "utf8");

    const llm = new CountingJsonLLM([jsonOutput("unused", "unused")]);
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: { responses_model: "gpt-5.4" }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain(
      "collect_lineage_topic_family_quality_thresholds_invalid"
    );
    expect(result.error).toContain("collect_lineage_topic_family_quality_floor_not_met");
    expect(llm.callCount).toBe(0);
  });

  it("rejects equivalent surface families as one independent coverage family", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-equivalent-families-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-equivalent-families";
    const run = makeRun(runId);
    const families = [
      {
        queryFamily: "query_family_finite",
        query: '"configured research" finite sample uncertainty',
        axisTerms: ["finite", "sample", "uncertainty"],
        lens: "finite sample uncertainty",
        contributionIntent: "measurement"
      },
      {
        queryFamily: "query_family_limited",
        query: '"configured research" limited sample uncertainty',
        axisTerms: ["limited", "sample", "uncertainty"],
        lens: "limited sample uncertainty",
        contributionIntent: "measurement"
      }
    ];
    const rows = families.flatMap((family, familyIndex) =>
      Array.from({ length: 4 }, (_, index) => ({
        paper_id: `paper_${familyIndex + 1}_${index + 1}`,
        title: `Configured research ${family.axisTerms.join(" ")} study ${index + 1}`,
        abstract: "Direct controlled evidence for the declared measurement family.",
        query_families: [family.queryFamily]
      }))
    );
    await writeCorpus(runId, rows);
    await writeTopicDiscoveryCollectLineage({
      run,
      collectAttemptId: "collect-attempt-equivalent-families",
      rows,
      families
    });
    await writeTopicDiscoveryBrief(run);
    const llm = new CountingJsonLLM([jsonOutput("unused", "unused")]);
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: { responses_model: "gpt-5.4" }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("collect_lineage_topic_family_quality_floor_not_met");
    expect(result.error).toContain("collect_lineage_topic_family_quality_observed_mismatch");
    expect(llm.callCount).toBe(0);
  });

  it("rejects a hash-consistent semantic family contract tamper against the v4 query plan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-family-contract-tamper-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-family-contract-tamper";
    const run = makeRun(runId);
    const fixture = completeTopicDiscoveryLineageFixture();
    await writeCorpus(runId, fixture.rows);
    await writeTopicDiscoveryCollectLineage({
      run,
      collectAttemptId: "collect-attempt-family-contract-tamper",
      ...fixture
    });
    await writeTopicDiscoveryBrief(run);
    const runDir = path.join(".autolabos", "runs", runId);
    const semanticInputPath = path.join(runDir, "collect_semantic_review_input.json");
    const semanticInput = JSON.parse(await readFile(semanticInputPath, "utf8")) as {
      payload_sha256?: string;
      payload?: {
        family_contracts?: Array<{ query?: string }>;
      };
    };
    const familyContract = semanticInput.payload?.family_contracts?.[0];
    if (!semanticInput.payload || !familyContract) {
      throw new Error("semantic_family_contract_fixture_missing");
    }
    familyContract.query = '"altered research" measurement reliability';
    const payloadRaw = JSON.stringify(semanticInput.payload);
    const payloadSha256 = createHash("sha256").update(payloadRaw, "utf8").digest("hex");
    const payloadBytes = Buffer.byteLength(payloadRaw, "utf8");
    semanticInput.payload_sha256 = payloadSha256;
    await writeFile(semanticInputPath, JSON.stringify(semanticInput), "utf8");

    const semanticReviewPath = path.join(runDir, "collect_semantic_review.json");
    const semanticReview = JSON.parse(await readFile(semanticReviewPath, "utf8")) as {
      reviewer_input_sha256?: string;
      reviewer_input_bytes?: number;
    };
    semanticReview.reviewer_input_sha256 = payloadSha256;
    semanticReview.reviewer_input_bytes = payloadBytes;
    await writeFile(semanticReviewPath, JSON.stringify(semanticReview), "utf8");

    const qualityPath = path.join(runDir, "collect_corpus_quality.json");
    const quality = JSON.parse(await readFile(qualityPath, "utf8")) as {
      semantic_review?: {
        reviewer_input_sha256?: string;
        reviewer_input_bytes?: number;
      };
    };
    if (!quality.semantic_review) {
      throw new Error("quality_semantic_review_fixture_missing");
    }
    quality.semantic_review.reviewer_input_sha256 = payloadSha256;
    quality.semantic_review.reviewer_input_bytes = payloadBytes;
    await writeFile(qualityPath, JSON.stringify(quality), "utf8");

    const llm = new CountingJsonLLM([jsonOutput("unused", "unused")]);
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: { responses_model: "gpt-5.4" }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain(
      "collect_lineage_topic_semantic_family_contract_mismatch"
    );
    expect(result.error).not.toContain("collect_lineage_topic_semantic_review_hash_mismatch");
    expect(llm.callCount).toBe(0);
  });

  it.each([
    {
      field: "version",
      expectedReason: "collect_lineage_manifest_contract_invalid",
      mutate: (manifest: Record<string, unknown>) => {
        manifest.version = 1;
      }
    },
    {
      field: "kind",
      expectedReason: "collect_lineage_manifest_contract_invalid",
      mutate: (manifest: Record<string, unknown>) => {
        manifest.kind = "collect_attempt_snapshot";
      }
    },
    {
      field: "run_id",
      expectedReason: "collect_lineage_manifest_contract_invalid",
      mutate: (manifest: Record<string, unknown>) => {
        manifest.run_id = "run-unrelated";
      }
    },
    {
      field: "revision_id",
      expectedReason: "collect_lineage_manifest_revision_mismatch",
      mutate: (manifest: Record<string, unknown>) => {
        const previousRevisionId = manifest.revision_id;
        const forgedRevisionId = `collection-${"0".repeat(20)}`;
        manifest.revision_id = forgedRevisionId;
        for (const file of Array.isArray(manifest.files) ? manifest.files : []) {
          if (
            file
            && typeof file === "object"
            && typeof (file as Record<string, unknown>).archived_path === "string"
            && typeof previousRevisionId === "string"
          ) {
            (file as Record<string, unknown>).archived_path = (
              (file as Record<string, unknown>).archived_path as string
            ).replace(previousRevisionId, forgedRevisionId);
          }
        }
      }
    },
    {
      field: "files",
      expectedReason: "collect_lineage_topic_archive_file_missing",
      mutate: (manifest: Record<string, unknown>) => {
        manifest.files = (Array.isArray(manifest.files) ? manifest.files : []).filter(
          (file) =>
            !file
            || typeof file !== "object"
            || (file as Record<string, unknown>).source_path
              !== "collect_topic_discovery_candidates.jsonl"
        );
      }
    }
  ])("rejects a topic-discovery archive manifest with invalid $field", async ({
    field,
    expectedReason,
    mutate
  }) => {
    const root = await mkdtemp(path.join(tmpdir(), `autolabos-analyze-manifest-${field}-`));
    tempDirs.push(root);
    process.chdir(root);

    const runId = `run-analyze-manifest-${field}`;
    const run = makeRun(runId);
    const fixture = completeTopicDiscoveryLineageFixture();
    await writeCorpus(runId, fixture.rows);
    await writeTopicDiscoveryCollectLineage({
      run,
      collectAttemptId: `collect-attempt-manifest-${field.replaceAll("_", "-")}`,
      ...fixture
    });
    await writeTopicDiscoveryBrief(run);
    const manifestPath = path.join(
      ".autolabos",
      "runs",
      runId,
      "collect_attempt_manifest.json"
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    mutate(manifest);
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");

    const llm = new CountingJsonLLM([jsonOutput("unused", "unused")]);
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: { responses_model: "gpt-5.4" }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain(expectedReason);
    expect(llm.callCount).toBe(0);
  });

  it("rejects a required topic-discovery artifact changed inside its immutable revision", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-archive-integrity-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-archive-integrity";
    const run = makeRun(runId);
    const fixture = completeTopicDiscoveryLineageFixture();
    await writeCorpus(runId, fixture.rows);
    await writeTopicDiscoveryCollectLineage({
      run,
      collectAttemptId: "collect-attempt-archive-integrity",
      ...fixture
    });
    await writeTopicDiscoveryBrief(run);
    const runDir = path.join(".autolabos", "runs", runId);
    const manifest = JSON.parse(
      await readFile(path.join(runDir, "collect_attempt_manifest.json"), "utf8")
    ) as {
      files?: Array<{ source_path?: string; archived_path?: string }>;
    };
    const archivedQualityPath = manifest.files?.find(
      (file) => file.source_path === "collect_corpus_quality.json"
    )?.archived_path;
    if (!archivedQualityPath) {
      throw new Error("archived_quality_fixture_missing");
    }
    await writeFile(
      path.join(runDir, archivedQualityPath),
      `${await readFile(path.join(runDir, archivedQualityPath), "utf8")} `,
      "utf8"
    );

    const llm = new CountingJsonLLM([jsonOutput("unused", "unused")]);
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: { responses_model: "gpt-5.4" }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain(
      "collect_lineage_manifest_immutable_artifact_mismatch"
    );
    expect(llm.callCount).toBe(0);
  });

  it("rejects coordinated semantic pair omission from the declared lexical universe", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-pair-universe-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-pair-universe";
    const run = makeRun(runId);
    const fixture = completeTopicDiscoveryLineageFixture();
    const omittedCandidate = {
      paper_id: "paper_measurement_extra",
      title: "Configured research measurement reliability extension",
      abstract: "Direct evidence for measurement reliability.",
      query_families: [fixture.families[0]!.queryFamily]
    };
    await writeCorpus(runId, fixture.rows);
    await writeTopicDiscoveryCollectLineage({
      run,
      collectAttemptId: "collect-attempt-pair-universe",
      ...fixture,
      candidateRows: [...fixture.rows, omittedCandidate],
      reviewedPairs: fixture.rows.flatMap((row) =>
        (row.query_families ?? []).map((familyId) => ({
          paper_id: row.paper_id,
          family_id: familyId
        }))
      )
    });
    await writeTopicDiscoveryBrief(run);

    const llm = new CountingJsonLLM([jsonOutput("unused", "unused")]);
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: { responses_model: "gpt-5.4" }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("collect_lineage_topic_candidate_pool_invalid");
    expect(result.error).toContain("collect_lineage_topic_semantic_pair_universe_mismatch");
    expect(llm.callCount).toBe(0);
  });

  it("blocks topic-discovery analysis when corpus family provenance diverges from collection quality", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-family-lineage-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-family-lineage";
    const run = makeRun(runId);
    const fixture = completeTopicDiscoveryLineageFixture();
    const corpusRows = fixture.rows.map((row, index) => index === 0
      ? { ...row, authors: ["Fixture Author"], query_families: undefined }
      : { ...row, authors: ["Fixture Author"] }
    );
    await writeCorpus(runId, corpusRows);
    const runDir = path.join(".autolabos", "runs", runId);
    const collectAttemptId = "20260102030405678-familylineage";
    await writeTopicDiscoveryCollectLineage({
      run,
      collectAttemptId,
      ...fixture
    });

    const llm = new CountingJsonLLM([jsonOutput("unused summary", "unused claim")]);
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: { responses_model: "gpt-5.4" }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });
    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain("collect_lineage_topic_family_missing");
    expect(result.error).toContain("collect_lineage_topic_family_count_mismatch");
    expect(llm.callCount).toBe(0);
    const gate = JSON.parse(
      await readFile(path.join(runDir, "analysis", "collect_lineage_gate.json"), "utf8")
    ) as { reasons?: string[] };
    expect(gate.reasons).toEqual(expect.arrayContaining([
      "collect_lineage_topic_family_missing",
      "collect_lineage_topic_family_count_mismatch"
    ]));
  });

  it("blocks unsupported v3 topic-discovery quality semantics even when the artifact says passed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-v3-quality-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-v3-quality";
    const run = makeRun(runId);
    const corpusRows = [
      {
        paper_id: "version3_p1",
        title: "Configured research reliability one",
        abstract: "A direct reliability study.",
        query_families: ["query_family_reliability"]
      },
      {
        paper_id: "version3_p2",
        title: "Configured research reliability two",
        abstract: "A second direct reliability study.",
        query_families: ["query_family_reliability"]
      }
    ];
    await writeCorpus(runId, corpusRows);
    const collectAttemptId = "collect-attempt-v3-quality";
    await writeTopicDiscoveryCollectLineage({
      run,
      collectAttemptId,
      rows: corpusRows,
      families: [{
        queryFamily: "query_family_reliability",
        query: '"configured research" reliability measurement',
        axisTerms: ["reliability", "measurement"],
        lens: "Direct measurement of research reliability",
        contributionIntent: "measurement"
      }]
    });
    const qualityPath = path.join(
      ".autolabos",
      "runs",
      runId,
      "collect_corpus_quality.json"
    );
    const versionThreeQuality = JSON.parse(await readFile(qualityPath, "utf8")) as {
      version?: number;
    };
    versionThreeQuality.version = 3;
    await writeFile(qualityPath, JSON.stringify(versionThreeQuality), "utf8");

    const llm = new CountingJsonLLM([jsonOutput("unused", "unused")]);
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: { responses_model: "gpt-5.4" }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain(
      "collect_lineage_topic_family_quality_semantics_unsupported"
    );
    expect(llm.callCount).toBe(0);
  });

  it("blocks topic-discovery analysis when semantic judgments are altered after collection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-semantic-tamper-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-semantic-tamper";
    const run = makeRun(runId);
    const corpusRows = [
      {
        paper_id: "tamper_p1",
        title: "Configured research measurement one",
        abstract: "A direct measurement study.",
        query_families: ["query_family_measurement"]
      },
      {
        paper_id: "tamper_p2",
        title: "Configured research measurement two",
        abstract: "A second direct measurement study.",
        query_families: ["query_family_measurement"]
      }
    ];
    await writeCorpus(runId, corpusRows);
    const collectAttemptId = "20260102030405678-semantictamper";
    await writeTopicDiscoveryCollectLineage({
      run,
      collectAttemptId,
      rows: corpusRows,
      families: [{
        queryFamily: "query_family_measurement",
        query: '"configured research" measurement validity',
        axisTerms: ["measurement", "validity"],
        lens: "Direct study of measurement validity",
        contributionIntent: "measurement"
      }]
    });
    const reviewPath = path.join(
      ".autolabos",
      "runs",
      runId,
      "collect_semantic_review.json"
    );
    const semanticReview = JSON.parse(await readFile(reviewPath, "utf8")) as {
      judgments?: Array<{ verdict?: string }>;
    };
    if (semanticReview.judgments?.[0]) {
      semanticReview.judgments[0].verdict = "application_only";
    }
    await writeFile(reviewPath, JSON.stringify(semanticReview), "utf8");

    const llm = new CountingJsonLLM([jsonOutput("unused", "unused")]);
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: { responses_model: "gpt-5.4" }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.error).toContain(
      "collect_lineage_topic_semantic_review_pair_mismatch"
    );
    expect(result.error).toContain(
      "collect_lineage_topic_semantic_direct_support_mismatch"
    );
    expect(llm.callCount).toBe(0);
  });

  it("reanalyzes a changed non-empty corpus when paper IDs stay the same", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-same-id-corpus-change-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-same-id-corpus-change";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      { paper_id: "retained_paper", title: "Retained Paper", abstract: "Initial abstract.", authors: ["Author"] }
    ]);

    const firstNode = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequenceJsonLLM([jsonOutput("stale summary", "stale claim")]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const first = await firstNode.execute({ run, graph: run.graph });
    expect(first.status).toBe("success");
    const firstManifest = JSON.parse(
      await readFile(path.join(".autolabos", "runs", runId, "analysis_manifest.json"), "utf8")
    ) as { corpusFingerprint?: string };

    await writeCorpus(runId, [
      {
        paper_id: "retained_paper",
        title: "Retained Paper",
        abstract: "Updated abstract from the replacement corpus.",
        authors: ["Author"]
      }
    ]);

    const eventStream = new InMemoryEventStream();
    const secondLlm = new CountingJsonLLM([jsonOutput("fresh summary", "fresh claim")]);
    const secondNode = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm: secondLlm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const second = await secondNode.execute({ run, graph: run.graph });
    expect(second.status).toBe("success");
    expect(secondLlm.callCount).toBeGreaterThan(0);

    const secondManifest = JSON.parse(
      await readFile(path.join(".autolabos", "runs", runId, "analysis_manifest.json"), "utf8")
    ) as { corpusFingerprint?: string; selectedPaperIds: string[] };
    expect(secondManifest.selectedPaperIds).toEqual(["retained_paper"]);
    expect(secondManifest.corpusFingerprint).toEqual(expect.any(String));
    expect(secondManifest.corpusFingerprint).not.toBe(firstManifest.corpusFingerprint);

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    const evidenceRaw = await readFile(path.join(".autolabos", "runs", runId, "evidence_store.jsonl"), "utf8");
    expect(summariesRaw.trim().split("\n")).toHaveLength(1);
    expect(evidenceRaw.trim().split("\n")).toHaveLength(1);
    expect(summariesRaw).toContain('"summary":"fresh summary"');
    expect(evidenceRaw).toContain('"claim":"fresh claim"');
    expect(summariesRaw).not.toContain("stale summary");
    expect(evidenceRaw).not.toContain("stale claim");

    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(loggedTexts.some((text) => text.includes("Collected corpus fingerprint changed"))).toBe(true);
  });

  it("reanalyzes a changed non-empty corpus when paper IDs are replaced", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-retarget-regression-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-retarget-regression";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      { paper_id: "prior_paper_one", title: "Prior Paper One", abstract: "Initial abstract one.", authors: ["Author"] },
      { paper_id: "prior_paper_two", title: "Prior Paper Two", abstract: "Initial abstract two.", authors: ["Author"] }
    ]);

    const firstNode = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequenceJsonLLM([
        jsonOutput("stale summary one", "stale claim one"),
        jsonOutput("stale summary two", "stale claim two")
      ]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const first = await firstNode.execute({ run, graph: run.graph });
    expect(first.status).toBe("success");
    const firstManifest = JSON.parse(
      await readFile(path.join(".autolabos", "runs", runId, "analysis_manifest.json"), "utf8")
    ) as { corpusFingerprint?: string };

    await writeCorpus(runId, [
      {
        paper_id: "replacement_paper",
        title: "Replacement Paper",
        abstract: "Replacement corpus abstract.",
        authors: ["Author"]
      }
    ]);

    const eventStream = new InMemoryEventStream();
    const secondLlm = new CountingJsonLLM([jsonOutput("fresh replacement summary", "fresh replacement claim")]);
    const secondNode = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm: secondLlm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const second = await secondNode.execute({ run, graph: run.graph });
    expect(second.status).toBe("success");
    expect(secondLlm.callCount).toBeGreaterThan(0);

    const manifestRaw = await readFile(path.join(".autolabos", "runs", runId, "analysis_manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw) as { corpusFingerprint?: string; selectedPaperIds: string[] };
    expect(manifest.selectedPaperIds).toEqual(["replacement_paper"]);
    expect(manifest.corpusFingerprint).toEqual(expect.any(String));
    expect(manifest.corpusFingerprint).not.toBe(firstManifest.corpusFingerprint);

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    const evidenceRaw = await readFile(path.join(".autolabos", "runs", runId, "evidence_store.jsonl"), "utf8");
    expect(summariesRaw.trim().split("\n")).toHaveLength(1);
    expect(evidenceRaw.trim().split("\n")).toHaveLength(1);
    expect(summariesRaw).toContain('"paper_id":"replacement_paper"');
    expect(summariesRaw).toContain('"summary":"fresh replacement summary"');
    expect(evidenceRaw).toContain('"claim":"fresh replacement claim"');
    expect(summariesRaw).not.toContain("stale summary");
    expect(evidenceRaw).not.toContain("stale claim");

    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(loggedTexts.some((text) => text.includes("Collected corpus fingerprint changed"))).toBe(true);
  });

  it("pauses with preserved partial evidence when retries stop shrinking the failed subset", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-stalled-retry-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-stalled-retry";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      { paper_id: "p1", title: "Paper 1", abstract: "Abstract 1", authors: ["Alice"] },
      { paper_id: "p2", title: "Paper 2", abstract: "Abstract 2", authors: ["Bob"] }
    ]);

    const firstNode = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequenceJsonLLM([jsonOutput("summary 1", "claim 1"), "invalid-json"]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const first = await firstNode.execute({ run, graph: run.graph });
    expect(first.status).toBe("success");
    expect(first.needsApproval).toBe(true);
    expect(first.transitionRecommendation?.action).toBe("pause_for_human");
    expect(first.summary).toContain("Preserved partial analysis");

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    const evidenceRaw = await readFile(path.join(".autolabos", "runs", runId, "evidence_store.jsonl"), "utf8");
    expect(summariesRaw.trim().split("\n")).toHaveLength(1);
    expect(evidenceRaw.trim().split("\n")).toHaveLength(1);

    expect(first.transitionRecommendation?.reason).toContain("preserved partial evidence");
    expect(first.transitionRecommendation?.evidence[0]).toContain("summary row(s)");
  });

  it("pauses after repeated zero-output retries when the failed subset does not shrink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-zero-output-retry-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-zero-output-retry";
    const run = makeRun(runId);
    await writeCorpus(runId, [{ paper_id: "p1", title: "Paper 1", abstract: "Abstract 1", authors: ["Alice"] }]);

    const firstNode = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequenceJsonLLM(["invalid-json"]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const first = await firstNode.execute({ run, graph: run.graph });
    expect(first.status).toBe("failure");

    run.graph.retryCounters.analyze_papers = 1;

    const eventStream = new InMemoryEventStream();
    const secondNode = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm: new SequenceJsonLLM(["invalid-json"]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const second = await secondNode.execute({ run, graph: run.graph });
    expect(second.status).toBe("success");
    expect(second.needsApproval).toBe(true);
    expect(second.transitionRecommendation?.action).toBe("pause_for_human");
    expect(second.summary).toContain("summaries or evidence");

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8").catch(() => "");
    const evidenceRaw = await readFile(path.join(".autolabos", "runs", runId, "evidence_store.jsonl"), "utf8").catch(() => "");
    expect(summariesRaw).toBe("");
    expect(evidenceRaw).toBe("");

    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(loggedTexts.some((text) => text.includes("No summaries or evidence were persisted"))).toBe(true);
  });

  it("pauses early on large zero-output passes instead of spending the entire analysis limit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-early-zero-output-"));
    tempDirs.push(root);
    process.chdir(root);
    await seedCodexOAuthHome(root);

    const runId = "run-analyze-early-zero-output";
    const run = makeRun(runId);
    await writeCorpus(
      runId,
      Array.from({ length: 15 }, (_, index) => ({
        paper_id: `p${index + 1}`,
        title: `Paper ${index + 1}`,
        abstract: `Abstract ${index + 1}`,
        authors: [`Author ${index + 1}`]
      }))
    );

    const llm = new CountingJsonLLM(Array.from({ length: 20 }, () => "invalid-json"));
    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        providers: makeCodexProviderConfig(),
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm,
      codex: makeCodexReadyStub(),
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
    expect(result.needsApproval).toBe(true);
    expect(result.transitionRecommendation?.action).toBe("pause_for_human");
    expect(result.summary).toContain("all failed before any summaries or evidence were persisted");
    expect(llm.callCount).toBeLessThan(15);
    expect(result.toolCallsUsed).toBeLessThan(15);

    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    expect(await runContext.get("analyze_papers.summary_count")).toBe(0);
    expect(await runContext.get("analyze_papers.evidence_count")).toBe(0);

    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(loggedTexts.some((text) => text.includes("Pausing instead of spending the rest of the selection"))).toBe(true);
  });

  it("uses a larger early timeout-only sample but keeps going once abstract fallbacks persist outputs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-timeout-zero-output-"));
    tempDirs.push(root);
    process.chdir(root);
    await seedCodexOAuthHome(root);

    process.env.AUTOLABOS_ANALYSIS_EXTRACT_TIMEOUT_MS = "5";

    const runId = "run-analyze-timeout-zero-output";
    const run = makeRun(runId);
    await writeCorpus(
      runId,
      Array.from({ length: 15 }, (_, index) => ({
        paper_id: `p${index + 1}`,
        title: `Paper ${index + 1}`,
        abstract: `Abstract ${index + 1}`,
        authors: [`Author ${index + 1}`]
      }))
    );

    const llm = new TimeoutOnlyExtractorLLM();
    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        providers: makeCodexProviderConfig(),
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm,
      codex: makeCodexReadyStub(),
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
    expect(result.needsApproval).toBe(true);
    expect(result.transitionRecommendation).toBeUndefined();

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    const evidenceRaw = await readFile(path.join(".autolabos", "runs", runId, "evidence_store.jsonl"), "utf8");
    expect(summariesRaw.trim().split("\n").length).toBeGreaterThanOrEqual(3);
    expect(evidenceRaw.trim().split("\n").length).toBeGreaterThanOrEqual(3);

    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(
      loggedTexts.some((text) =>
        text.includes("Abstract-only analysis still timed out. Using a deterministic abstract fallback analysis")
      )
    ).toBe(true);
    expect(
      loggedTexts.some((text) =>
        text.includes("Warm-start persisted outputs; continuing remaining")
      )
    ).toBe(true);
  });


  it("retries once without supplemental page images when the full-text extractor times out", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-image-timeout-fallback-"));
    tempDirs.push(root);
    process.chdir(root);
    await seedCodexOAuthHome(root);

    process.env.AUTOLABOS_ANALYSIS_EXTRACT_TIMEOUT_MS = "5";

    const runId = "run-analyze-image-timeout-fallback";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      {
        paper_id: "p1",
        title: "Paper 1",
        abstract: "Abstract 1",
        authors: ["Alice"],
        pdf_url: "https://example.com/p1.pdf"
      }
    ]);
    writeCachedPaperTextSync(runId, "p1", "Cached article body recovered for analysis");
    writeCachedPageImagesSync(runId, "p1", 3);

    const llm = new ImagePayloadTimeoutLLM();
    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        providers: {
          llm_mode: "codex_chatgpt_only",
          codex: {
            model: "gpt-5.4",
            pdf_model: "gpt-5.4"
          }
        },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm,
      pdfTextLlm: llm,
      codex: {
        checkCliAvailable: async () => ({ ok: true, detail: "codex available" }),
        checkLoginStatus: async () => ({ ok: true, detail: "logged in" }),
        checkEnvironmentReadiness: async () => []
      } as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
    expect(result.needsApproval).toBe(true);
    expect(llm.extractorCallsWithImages).toBe(1);
    expect(llm.extractorCallsWithoutImages).toBe(1);

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    expect(summariesRaw).toContain("reviewed summary");
    expect(summariesRaw).toContain('"source_type":"full_text"');

    const manifestRaw = await readFile(
      path.join(".autolabos", "runs", runId, "analysis_manifest.json"),
      "utf8"
    );
    expect(manifestRaw).toContain('"status": "completed"');
    expect(manifestRaw).toContain('"source_type": "full_text"');

    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(loggedTexts.some((text) => text.includes("Retrying once with full text only"))).toBe(true);
  });

  it("materializes a deterministic abstract-only fallback immediately when full-text retries still time out", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-abstract-timeout-fallback-"));
    tempDirs.push(root);
    process.chdir(root);
    await seedCodexOAuthHome(root);

    process.env.AUTOLABOS_ANALYSIS_EXTRACT_TIMEOUT_MS = "5";

    const runId = "run-analyze-abstract-timeout-fallback";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      {
        paper_id: "p1",
        title: "Paper 1",
        abstract: "Abstract 1",
        authors: ["Alice"],
        pdf_url: "https://example.com/p1.pdf"
      }
    ]);
    writeCachedPaperTextSync(runId, "p1", "Cached article body recovered for analysis");
    writeCachedPageImagesSync(runId, "p1", 3);

    const llm = new FullTextThenAbstractFallbackLLM();
    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        providers: {
          llm_mode: "codex_chatgpt_only",
          codex: {
            model: "gpt-5.4",
            pdf_model: "gpt-5.4"
          }
        },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm,
      pdfTextLlm: llm,
      codex: {
        checkCliAvailable: async () => ({ ok: true, detail: "codex available" }),
        checkLoginStatus: async () => ({ ok: true, detail: "logged in" }),
        checkEnvironmentReadiness: async () => []
      } as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
    expect(result.needsApproval).toBe(true);
    expect(llm.extractorCallsWithImages).toBe(1);
    expect(llm.extractorCallsWithoutImages).toBe(1);
    expect(llm.extractorCallsAbstract).toBe(0);

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    expect(summariesRaw).toContain("Abstract 1");
    expect(summariesRaw).toContain('"source_type":"abstract"');

    const manifestRaw = await readFile(
      path.join(".autolabos", "runs", runId, "analysis_manifest.json"),
      "utf8"
    );
    expect(manifestRaw).toContain('"status": "completed"');
    expect(manifestRaw).toContain('"source_type": "abstract"');
    expect(manifestRaw).toContain('"fallback_reason": "analysis_timeout_abstract_fallback"');

    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(loggedTexts.some((text) => text.includes("Retrying once with full text only"))).toBe(true);
    expect(
      loggedTexts.some((text) =>
        text.includes("Falling back to abstract-only analysis for this paper")
      )
    ).toBe(true);
    expect(
      loggedTexts.some((text) =>
        text.includes("Using a deterministic abstract fallback immediately after repeated full-text timeouts")
      )
    ).toBe(true);
  });

  it("materializes a deterministic full-text fallback immediately when the planner times out on the first selected paper", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-fulltext-planner-timeout-"));
    tempDirs.push(root);
    process.chdir(root);
    await seedCodexOAuthHome(root);

    process.env.AUTOLABOS_ANALYSIS_PLANNER_TIMEOUT_MS = "5";

    const runId = "run-analyze-fulltext-planner-timeout";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      {
        paper_id: "p1",
        title: "Paper 1",
        abstract: "Abstract 1",
        authors: ["Alice"],
        pdf_url: "https://example.com/p1.pdf"
      }
    ]);
    writeCachedPaperTextSync(
      runId,
      "p1",
      "Cached article body describing a general candidate-comparison protocol. The system was evaluated on Benchmark Task A and Benchmark Task B under a fixed budget. Metrics: outcome_quality and elapsed_time."
    );
    writeCachedPageImagesSync(runId, "p1", 3);

    const llm = new HangingPlannerOnlyLLM();
    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        providers: {
          llm_mode: "codex_chatgpt_only",
          codex: {
            model: "gpt-5.4",
            pdf_model: "gpt-5.4"
          }
        },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm,
      pdfTextLlm: llm,
      codex: {
        checkCliAvailable: async () => ({ ok: true, detail: "codex available" }),
        checkLoginStatus: async () => ({ ok: true, detail: "logged in" }),
        checkEnvironmentReadiness: async () => []
      } as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
    expect(result.needsApproval).toBe(true);

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    expect(summariesRaw).toContain('"source_type":"full_text"');
    expect(summariesRaw).toContain("Benchmark Task A and Benchmark Task B");

    const evidenceRaw = await readFile(path.join(".autolabos", "runs", runId, "evidence_store.jsonl"), "utf8");
    expect(evidenceRaw).toContain('"source_type":"full_text"');
    expect(evidenceRaw).toContain("Benchmark Task A and Benchmark Task B");
    expect(evidenceRaw).toContain('"metric_slot":"outcome_quality; elapsed_time"');
    expect(evidenceRaw).toContain('"confidence":0.62');

    const manifestRaw = await readFile(
      path.join(".autolabos", "runs", runId, "analysis_manifest.json"),
      "utf8"
    );
    expect(manifestRaw).toContain('"status": "completed"');
    expect(manifestRaw).toContain('"source_type": "full_text"');

    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(
      loggedTexts.some((text) =>
        text.includes("Planner timed out on a full-text source. Using a deterministic source-grounded fallback analysis")
      )
    ).toBe(true);
    expect(loggedTexts.some((text) => text.includes('Persisted analysis outputs for "Paper 1"'))).toBe(true);
  });

  it.each([
    ["typed OAuth quota", new CodexOAuthCompletionError("quota_exhausted")],
    [
      "plain provider message",
      new Error(
        "You've hit your usage limit for the configured model. Switch to another model now, or try again later."
      )
    ]
  ])("pauses for human on %s before any outputs are produced", async (_label, providerError) => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-usage-limit-"));
    tempDirs.push(root);
    process.chdir(root);
    await seedCodexOAuthHome(root);

    const runId = "run-analyze-usage-limit";
    const run = makeRun(runId);
    await writeCorpus(runId, [{ paper_id: "p1", title: "Paper 1", abstract: "Abstract 1", authors: ["Alice"] }]);

    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        providers: makeCodexProviderConfig(),
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm: new FixedErrorLLM(providerError),
      codex: makeCodexReadyStub(),
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
    expect(result.needsApproval).toBe(true);
    expect(result.transitionRecommendation?.action).toBe("pause_for_human");
    expect(result.summary).toContain("usage limit");

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8").catch(() => "");
    const evidenceRaw = await readFile(path.join(".autolabos", "runs", runId, "evidence_store.jsonl"), "utf8").catch(() => "");
    expect(summariesRaw).toBe("");
    expect(evidenceRaw).toBe("");

    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    expect(await runContext.get("analyze_papers.summary_count")).toBe(0);
    expect(await runContext.get("analyze_papers.evidence_count")).toBe(0);

    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(loggedTexts.some((text) => text.includes("model usage-limit failure"))).toBe(true);
  });

  it("pauses before starting when the Codex environment preflight reports an unwritable home", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-env-preflight-"));
    tempDirs.push(root);
    process.chdir(root);
    await seedCodexOAuthHome(root);

    const runId = "run-analyze-env-preflight";
    const run = makeRun(runId);
    await writeCorpus(runId, [{ paper_id: "p1", title: "Paper 1", abstract: "Abstract 1", authors: ["Alice"] }]);

    const llm = new CountingJsonLLM([jsonOutput("summary 1", "claim 1")]);
    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        providers: {
          llm_mode: "codex_chatgpt_only",
          codex: {
            model: "gpt-5.4",
            pdf_model: "gpt-5.4"
          }
        },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm,
      codex: {
        checkCliAvailable: async () => ({ ok: true, detail: "codex available" }),
        checkLoginStatus: async () => ({ ok: true, detail: "logged in" }),
        checkEnvironmentReadiness: async () => [
          {
            name: "codex-home",
            ok: false,
            blocking: true,
            detail: `${root}/.codex is not writable`
          }
        ]
      } as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
    expect(result.needsApproval).toBe(true);
    expect(result.summary).toContain("Codex CLI environment is not writable or ready");
    expect(result.transitionRecommendation?.action).toBe("pause_for_human");
    expect(llm.callCount).toBe(0);

    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(loggedTexts.some((text) => text.includes("Codex preflight failed [codex-home]"))).toBe(true);
  });

  it("pauses before starting when the configured Codex research backend model is Spark", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-spark-preflight-"));
    tempDirs.push(root);
    process.chdir(root);
    await seedCodexOAuthHome(root);

    const runId = "run-analyze-spark-preflight";
    const run = makeRun(runId);
    await writeCorpus(runId, [{ paper_id: "p1", title: "Paper 1", abstract: "Abstract 1", authors: ["Alice"] }]);

    const llm = new CountingJsonLLM([jsonOutput("summary 1", "claim 1")]);
    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        providers: {
          llm_mode: "codex_chatgpt_only",
          codex: {
            model: "gpt-5.3-codex-spark",
            pdf_model: "gpt-5.4"
          }
        },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm,
      codex: {
        checkCliAvailable: async () => ({ ok: true, detail: "codex available" }),
        checkLoginStatus: async () => ({ ok: true, detail: "logged in" })
      } as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
    expect(result.needsApproval).toBe(true);
    expect(result.summary).toContain("configured Codex research backend model");
    expect(result.transitionRecommendation?.action).toBe("pause_for_human");
    expect(result.transitionRecommendation?.reason).toContain("research backend model");
    expect(llm.callCount).toBe(0);

    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(loggedTexts.some((text) => text.includes("Codex preflight failed [codex-research-backend-model]"))).toBe(true);
  });

  it("preserves partial analysis and pauses when later papers hit environment permission errors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-env-partial-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-env-partial";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      { paper_id: "p1", title: "Paper 1", abstract: "Abstract 1", authors: ["Alice"] },
      { paper_id: "p2", title: "Paper 2", abstract: "Abstract 2", authors: ["Bob"] }
    ]);

    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm: new SequenceResponseLlm([
        jsonOutput("summary 1", "claim 1"),
        new Error("failed to write models cache: Operation not permitted")
      ]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
    expect(result.needsApproval).toBe(true);
    expect(result.summary).toContain("Preserved partial analysis");
    expect(result.summary).toContain("environment or permission errors");
    expect(result.transitionRecommendation?.action).toBe("pause_for_human");

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    const evidenceRaw = await readFile(path.join(".autolabos", "runs", runId, "evidence_store.jsonl"), "utf8");
    expect(summariesRaw.trim().split("\n")).toHaveLength(1);
    expect(evidenceRaw.trim().split("\n")).toHaveLength(1);

    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(loggedTexts.some((text) => text.includes("environment or permission failure"))).toBe(true);
  });

  it("pauses after persisting an exhausted small corpus when every analyzed paper is abstract fallback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-abstract-only-exhausted-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-abstract-only-exhausted";
    const run = makeRun(runId);
    await writeCorpus(
      runId,
      Array.from({ length: 4 }, (_, index) => ({
        paper_id: `p${index + 1}`,
        title: `Paper ${index + 1}`,
        abstract: `Abstract ${index + 1}`,
        authors: [`Author ${index + 1}`]
      }))
    );

    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm: new SequenceJsonLLM([
        jsonOutput("summary 1", "claim 1"),
        jsonOutput("summary 2", "claim 2"),
        jsonOutput("summary 3", "claim 3"),
        jsonOutput("summary 4", "claim 4")
      ]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
    expect(result.needsApproval).toBe(true);
    expect(result.summary).toContain("abstract-fallback");
    expect(result.transitionRecommendation?.action).toBe("pause_for_human");
    expect(result.transitionRecommendation?.reason).toContain("abstract-level evidence");

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    const evidenceRaw = await readFile(path.join(".autolabos", "runs", runId, "evidence_store.jsonl"), "utf8");
    expect(summariesRaw.trim().split("\n")).toHaveLength(4);
    expect(evidenceRaw.trim().split("\n")).toHaveLength(4);
    expect(summariesRaw).toContain('"source_type":"abstract"');
    expect(summariesRaw).not.toContain('"source_type":"full_text"');

    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    expect(await runContext.get("analyze_papers.summary_count")).toBe(4);
    expect(await runContext.get("analyze_papers.evidence_count")).toBe(4);
    expect(await runContext.get("analyze_papers.full_text_count")).toBe(0);
    expect(await runContext.get("analyze_papers.abstract_fallback_count")).toBe(4);

    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(
      loggedTexts.some((text) =>
        text.includes("Pausing for manual review instead of auto-unblocking downstream hypothesis/experiment generation")
      )
    ).toBe(true);
  });

  it("uses serial warm-start only for the first paper, then resumes normal concurrency", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-serial-warm-start-"));
    tempDirs.push(root);
    process.chdir(root);
    await seedCodexOAuthHome(root);

    const runId = "run-analyze-serial-warm-start";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      { paper_id: "p1", title: "Paper 1", abstract: "Abstract 1", authors: ["Alice"] },
      { paper_id: "p2", title: "Paper 2", abstract: "Abstract 2", authors: ["Bob"] },
      { paper_id: "p3", title: "Paper 3", abstract: "Abstract 3", authors: ["Cara"] },
      { paper_id: "p4", title: "Paper 4", abstract: "Abstract 4", authors: ["Dan"] }
    ]);

    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    await runContext.put("analyze_papers.request", {
      selectionMode: "all",
      selectionPolicy: "hybrid_title_citation_recency_pdf_v2",
      topN: null
    });

    const repeatedJson = Array.from({ length: 16 }, (_, index) => jsonOutput(`summary ${index}`, `claim ${index}`));
    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        providers: makeCodexProviderConfig(),
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm: new SequenceJsonLLM(repeatedJson),
      pdfTextLlm: new SequenceJsonLLM(repeatedJson),
      codex: makeCodexReadyStub(),
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(loggedTexts.some((text) => text.includes("Analyzing 4 paper(s) with concurrency 1."))).toBe(true);
    expect(loggedTexts.some((text) => text.includes("Serial warm-start is enabled until the first persisted outputs arrive."))).toBe(true);
    expect(
      loggedTexts.some((text) =>
        text.includes("Warm-start persisted outputs; continuing remaining 3 paper(s) with concurrency 3.")
      )
    ).toBe(true);
  });

  it("rejects mismatched full-text sources before persisting analysis artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-source-mismatch-"));
    tempDirs.push(root);
    process.chdir(root);
    await seedCodexOAuthHome(root);

    const runId = "run-analyze-source-mismatch";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      {
        paper_id: "p1",
        title: "Predicting multi-factor authentication uptake using machine learning and the UTAUT framework",
        abstract: "Abstract 1",
        authors: ["Alice Smith"],
        pdf_url: "https://example.com/p1.pdf"
      }
    ]);

    await mkdir(path.join(".autolabos", "runs", runId, "analysis_cache", "texts"), { recursive: true });
    await writeFile(
      path.join(".autolabos", "runs", runId, "analysis_cache", "texts", "p1.v3.txt"),
      "This study presents a structured literature review of machine learning applications in African economies and digital transformation.",
      "utf8"
    );

    const llm = new CountingJsonLLM([jsonOutput("mismatch summary", "mismatch claim")]);
    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        providers: makeCodexProviderConfig(),
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm,
      codex: makeCodexReadyStub(),
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
    expect(result.needsApproval).toBe(true);
    expect(result.transitionRecommendation?.action).toBe("pause_for_human");
    expect(llm.callCount).toBe(0);

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8").catch(() => "");
    const evidenceRaw = await readFile(path.join(".autolabos", "runs", runId, "evidence_store.jsonl"), "utf8").catch(() => "");
    expect(summariesRaw).toBe("");
    expect(evidenceRaw).toBe("");
    const manifestRaw = await readFile(path.join(".autolabos", "runs", runId, "analysis_manifest.json"), "utf8");
    expect(manifestRaw).toContain("source_content_mismatch");
    const quarantineRaw = await readFile(path.join(".autolabos", "runs", runId, "analysis_quarantine.jsonl"), "utf8");
    expect(quarantineRaw).toContain('"paper_id":"p1"');
    expect(quarantineRaw).toContain("source_content_mismatch");

    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    expect(await runContext.get("analyze_papers.summary_count")).toBe(0);
    expect(await runContext.get("analyze_papers.evidence_count")).toBe(0);
    const gapMap = JSON.parse(
      await readFile(path.join(".autolabos", "runs", runId, "analysis", "gap_map.json"), "utf8")
    ) as { gaps?: unknown[]; evidence_byte_length?: number };
    expect(gapMap.gaps).toEqual([]);
    expect(gapMap.evidence_byte_length).toBe(0);
  }, 10000);

  it("does not treat an ordinary bibliographic metadata discrepancy as a source-identity mismatch", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-metadata-discrepancy-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-metadata-discrepancy";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      {
        paper_id: "p1",
        title: "Evaluation records across publication indexes",
        abstract: "The study compares bibliographic records across publication indexes.",
        authors: ["Alice"]
      }
    ]);
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: { responses_model: "gpt-5.4" }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequenceJsonLLM([
        jsonOutput(
          "A bibliographic metadata mismatch across indexes is reported as a limitation.",
          "metadata discrepancy"
        )
      ]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    const summariesRaw = await readFile(
      path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"),
      "utf8"
    );
    expect(summariesRaw).toContain("bibliographic metadata mismatch");
    const quarantineRaw = await readFile(
      path.join(".autolabos", "runs", runId, "analysis_quarantine.jsonl"),
      "utf8"
    ).catch(() => "");
    expect(quarantineRaw).toBe("");
    const manifestRaw = await readFile(
      path.join(".autolabos", "runs", runId, "analysis_manifest.json"),
      "utf8"
    );
    expect(manifestRaw).toContain('"status": "completed"');
    expect(manifestRaw).not.toContain("analysis_content_mismatch");
  });

  it("validates local full-text identity before spending a Responses API call", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-pdf-fallback-mismatch-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-pdf-fallback-mismatch";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      {
        paper_id: "p1",
        title: "Predicting multi-factor authentication uptake using machine learning and the UTAUT framework",
        abstract: "Abstract 1",
        authors: ["Alice Smith"],
        pdf_url: "https://example.com/p1.pdf"
      }
    ]);

    await mkdir(path.join(".autolabos", "runs", runId, "analysis_cache", "texts"), { recursive: true });
    await writeFile(
      path.join(".autolabos", "runs", runId, "analysis_cache", "texts", "p1.v3.txt"),
      "This source text is actually an unrelated paper about economic transformation in Africa and digital inclusion.",
      "utf8"
    );

    const llm = new CountingJsonLLM([jsonOutput("should not run", "should not run")]);
    const pdfTextLlm = new CountingJsonLLM([jsonOutput("should not run", "should not run")]);
    let responsesPdfCalls = 0;
    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm,
      pdfTextLlm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {
        hasApiKey: async () => true,
        analyzePdf: async () => {
          responsesPdfCalls += 1;
          throw new Error(
            'Responses API request failed: 400 { "error": { "message": "Timeout while downloading https://example.com/p1.pdf" } }'
          );
        }
      } as unknown as ResponsesPdfAnalysisClient
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
    expect(result.needsApproval).toBe(true);
    expect(result.transitionRecommendation?.action).toBe("pause_for_human");
    expect(llm.callCount).toBe(0);
    expect(pdfTextLlm.callCount).toBe(0);
    expect(responsesPdfCalls).toBe(0);

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8").catch(() => "");
    const evidenceRaw = await readFile(path.join(".autolabos", "runs", runId, "evidence_store.jsonl"), "utf8").catch(() => "");
    expect(summariesRaw).toBe("");
    expect(evidenceRaw).toBe("");

    const quarantineRaw = await readFile(path.join(".autolabos", "runs", runId, "analysis_quarantine.jsonl"), "utf8");
    expect(quarantineRaw).toContain('"paper_id":"p1"');
    expect(quarantineRaw).toContain("source_content_mismatch");

    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(loggedTexts.some((text) => text.includes("Responses API could not download the remote PDF"))).toBe(false);
    expect(loggedTexts.some((text) => text.includes("source-identity mismatch"))).toBe(true);
  });

  it("filters off-topic rerank selections and promotes anchored replacements", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-fallback-guard-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-fallback-guard";
    const run = {
      ...makeRun(runId),
      title: "Bounded baseline comparisons for structured records",
      topic: "Bounded baseline comparisons for structured records"
    };
    await writeCorpus(runId, [
      {
        paper_id: "p1",
        title: "Bounded baseline comparisons for structured records",
        abstract: "Baseline comparison on structured records with two declared reference systems.",
        authors: ["Alice"],
        citation_count: 5,
        year: 2022,
        pdf_url: "https://example.com/p1.pdf"
      },
      {
        paper_id: "p2",
        title: "A Study on Music Genre Classification using Machine Learning",
        abstract: "Classification model for audio genre recognition.",
        authors: ["Bob"],
        citation_count: 500,
        year: 2025,
        pdf_url: "https://example.com/p2.pdf"
      },
      {
        paper_id: "p3",
        title: "Reference comparisons for structured records",
        abstract: "Baseline study on held-out structured records.",
        authors: ["Cara"],
        citation_count: 10,
        year: 2023,
        pdf_url: "https://example.com/p3.pdf"
      }
    ]);

    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    await runContext.put("analyze_papers.request", {
      topN: 2,
      selectionMode: "top_n",
      selectionPolicy: "hybrid_title_citation_recency_pdf_v2"
    });

    let analyzePdfCalls = 0;
    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm: new SequenceJsonLLM([JSON.stringify({ ordered_paper_ids: ["p2", "p1", "p3"] })]),
      pdfTextLlm: new SequenceJsonLLM([]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {
        hasApiKey: async () => true,
        analyzePdf: async () => {
          analyzePdfCalls += 1;
          return { text: jsonOutput(`summary ${analyzePdfCalls}`, `claim ${analyzePdfCalls}`) };
        }
      } as unknown as ResponsesPdfAnalysisClient
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
    expect(analyzePdfCalls).toBe(2);

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    expect(summariesRaw).toContain('"paper_id":"p1"');
    expect(summariesRaw).toContain('"paper_id":"p3"');
    expect(summariesRaw).not.toContain('"paper_id":"p2"');

    const manifestRaw = await readFile(path.join(".autolabos", "runs", runId, "analysis_manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.selectedPaperIds).toEqual(["p1", "p3"]);

  });

  it("keeps fallback shortlist focused on strong title anchors for a neutral configuration brief", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-config-fallback-guard-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-config-fallback-guard";
    const run = {
      ...makeRun(runId),
      title: "Window size and cache policy interaction for streaming summarization",
      topic:
        "Measure how window size and cache policy affect streaming summarization quality against a fixed baseline."
    };
    await writeCorpus(runId, [
      {
        paper_id: "relevant_windowed_context",
        title: "Windowed Context Control for Streaming Summarization",
        abstract:
          "Windowed context control improves streaming summarization under bounded latency.",
        authors: ["Alice"],
        citation_count: 87,
        year: 2023,
        pdf_url: "https://example.com/bactrian.pdf"
      },
      {
        paper_id: "relevant_cache_policy",
        title: "Cache Policy Trade-offs in Streaming Text Summarization",
        abstract:
          "A controlled study of cache policy settings for streaming text summarization systems.",
        authors: ["Bob"],
        citation_count: 12,
        year: 2025,
        pdf_url: "https://example.com/condition-parameter.pdf"
      },
      {
        paper_id: "off_topic_medical_notes",
        title: "Using fine-tuned large language models to parse clinical notes in musculoskeletal pain disorders",
        abstract:
          "A clinical-note parsing study that uses unrelated domain-specific annotation data.",
        authors: ["Cara"],
        citation_count: 38,
        year: 2023,
        pdf_url: "https://example.com/clinical.pdf"
      },
      {
        paper_id: "off_topic_medical_vision",
        title: "Point, Detect, Count: Multi-Task Medical Image Understanding with Instruction-Tuned Vision-Language Models",
        abstract:
          "A medical-image vision-language paper that targets multimodal detection and counting tasks.",
        authors: ["Dana"],
        citation_count: 2,
        year: 2025,
        pdf_url: "https://example.com/vision.pdf"
      }
    ]);

    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    await runContext.put("analyze_papers.request", {
      topN: 2,
      selectionMode: "top_n",
      selectionPolicy: "hybrid_title_citation_recency_pdf_v2"
    });

    let analyzePdfCalls = 0;
    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm: new FixedErrorLLM(new Error("paper_selection_rerank_timeout_after_20000ms")),
      pdfTextLlm: new SequenceJsonLLM([]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {
        hasApiKey: async () => true,
        analyzePdf: async () => {
          analyzePdfCalls += 1;
          return { text: jsonOutput(`summary ${analyzePdfCalls}`, `claim ${analyzePdfCalls}`) };
        }
      } as unknown as ResponsesPdfAnalysisClient
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
    expect(analyzePdfCalls).toBe(2);

    const manifestRaw = await readFile(path.join(".autolabos", "runs", runId, "analysis_manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw);
    expect(new Set(manifest.selectedPaperIds)).toEqual(new Set(["relevant_windowed_context", "relevant_cache_policy"]));

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    expect(summariesRaw).toContain('"paper_id":"relevant_windowed_context"');
    expect(summariesRaw).toContain('"paper_id":"relevant_cache_policy"');
    expect(summariesRaw).not.toContain('"paper_id":"off_topic_medical_notes"');
    expect(summariesRaw).not.toContain('"paper_id":"off_topic_medical_vision"');
  });

  it("keeps fallback shortlist focused on the brief mechanism instead of keyword-heavy adjacent domains", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-mechanism-brief-guard-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-mechanism-brief-guard";
    const run = {
      ...makeRun(runId),
      title: "Identify which bounded graph-sketch update choices matter for local anomaly detectors",
      topic:
        "Identify which graph-sketch update and retention choices matter for local anomaly detection under a workstation budget while keeping the comparison small and executable."
    };
    await writeCorpus(runId, [
      {
        paper_id: "relevant_graph_update",
        title: "Degree-Aware Sketch Updates for Local Graph Anomaly Detection",
        abstract:
          "A bounded study of graph-sketch update rules under a local compute budget.",
        authors: ["Alice"],
        citation_count: 52,
        year: 2024,
        pdf_url: "https://example.com/graph-update.pdf"
      },
      {
        paper_id: "relevant_retention_tradeoff",
        title: "Retention Policy Trade-offs in Compact Graph Sketches",
        abstract:
          "Compares bounded retention-policy changes for local graph sketches under fixed compute.",
        authors: ["Bob"],
        citation_count: 15,
        year: 2025,
        pdf_url: "https://example.com/retention-tradeoffs.pdf"
      },
      {
        paper_id: "off_topic_clinical_graph",
        title: "Graph Representations for Longitudinal Clinical Risk Modeling",
        abstract:
          "This clinical study mentions local graph updates and anomaly signals but targets longitudinal patient-risk prediction.",
        authors: ["Cara"],
        citation_count: 75,
        year: 2023,
        pdf_url: "https://example.com/clinical-graph.pdf"
      },
      {
        paper_id: "off_topic_graph_recommender",
        title: "A Multimodal Recommender with Dynamic Graph Retention",
        abstract:
          "A recommender study that mentions graph retention and anomaly-aware updates but targets recommendation-specific fusion.",
        authors: ["Dina"],
        citation_count: 66,
        year: 2025,
        pdf_url: "https://example.com/multimodal-rec.pdf"
      }
    ]);

    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    await runContext.put("analyze_papers.request", {
      topN: 2,
      selectionMode: "top_n",
      selectionPolicy: "hybrid_title_citation_recency_pdf_v2"
    });

    let analyzePdfCalls = 0;
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new FixedErrorLLM(new Error("paper_selection_rerank_timeout_after_20000ms")),
      pdfTextLlm: new SequenceJsonLLM([]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {
        hasApiKey: async () => true,
        analyzePdf: async () => {
          analyzePdfCalls += 1;
          return { text: jsonOutput(`summary ${analyzePdfCalls}`, `claim ${analyzePdfCalls}`) };
        }
      } as unknown as ResponsesPdfAnalysisClient
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
    expect(analyzePdfCalls).toBe(2);

    const manifestRaw = await readFile(path.join(".autolabos", "runs", runId, "analysis_manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw);
    expect(new Set(manifest.selectedPaperIds)).toEqual(new Set(["relevant_graph_update", "relevant_retention_tradeoff"]));

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    expect(summariesRaw).toContain('"paper_id":"relevant_graph_update"');
    expect(summariesRaw).toContain('"paper_id":"relevant_retention_tradeoff"');
    expect(summariesRaw).not.toContain('"paper_id":"off_topic_clinical_graph"');
    expect(summariesRaw).not.toContain('"paper_id":"off_topic_graph_recommender"');
  });

  it("pauses instead of accepting a deterministic shortlist when top-n rerank fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-rerank-required-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-rerank-required";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      { paper_id: "p1", title: "Paper 1", abstract: "Abstract 1", authors: ["Alice"], pdf_url: "https://example.com/p1.pdf" },
      { paper_id: "p2", title: "Paper 2", abstract: "Abstract 2", authors: ["Bob"], pdf_url: "https://example.com/p2.pdf" },
      { paper_id: "p3", title: "Paper 3", abstract: "Abstract 3", authors: ["Cara"], pdf_url: "https://example.com/p3.pdf" }
    ]);

    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    await runContext.put("analyze_papers.request", {
      topN: 2,
      selectionMode: "top_n",
      selectionPolicy: "hybrid_title_citation_recency_pdf_v2"
    });

    let analyzePdfCalls = 0;
    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm: new FixedErrorLLM(new Error("rerank unavailable")),
      pdfTextLlm: new SequenceJsonLLM([]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {
        hasApiKey: async () => true,
        analyzePdf: async () => {
          analyzePdfCalls += 1;
          return { text: jsonOutput("should not run", "should not run") };
        }
      } as unknown as ResponsesPdfAnalysisClient
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    expect(result.needsApproval).toBe(true);
    expect(result.summary).toContain("LLM rerank for top 2 failed");
    expect(result.transitionRecommendation?.action).toBe("pause_for_human");
    expect(analyzePdfCalls).toBe(0);

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8").catch(() => "");
    const manifestRaw = await readFile(path.join(".autolabos", "runs", runId, "analysis_manifest.json"), "utf8").catch(() => "");
    expect(summariesRaw).toBe("");
    expect(manifestRaw).toBe("");

    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(loggedTexts.some((text) => text.includes("LLM rerank failed. Top 2 selection requires a successful model rerank"))).toBe(true);
  });

  it("uses Responses API PDF analysis when configured and a PDF URL is present", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-pdf-api-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-pdf-api";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      {
        paper_id: "p1",
        title: "Paper 1",
        abstract: "Abstract 1",
        authors: ["Alice"],
        pdf_url: "https://example.com/p1.pdf"
      }
    ]);

    const responseClient = {
      hasApiKey: async () => true,
      analyzePdf: async () => ({ text: jsonOutput("pdf summary", "pdf claim") })
    } as unknown as ResponsesPdfAnalysisClient;

    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequenceJsonLLM(["should-not-be-used"]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: responseClient
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    expect(summariesRaw).toContain('"source_type":"full_text"');
    expect(summariesRaw).toContain('"summary":"pdf summary"');
  });

  it("refreshes selected corpus rows when PDF enrichment lands after analyze_papers starts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-late-pdf-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-late-pdf";
    const run = makeRun(runId);
    const initialRow = {
      paper_id: "p1",
      title: "Paper 1",
      abstract: "Abstract 1",
      authors: ["Alice"],
      url: "https://example.com/p1"
    };
    const secondRow = {
      paper_id: "p2",
      title: "Paper 2",
      abstract: "Abstract 2",
      authors: ["Bob"],
      url: "https://example.com/p2"
    };
    const enrichedRow = {
      ...initialRow,
      pdf_url: "https://example.com/p1.pdf"
    };
    await writeCorpus(runId, [initialRow, secondRow]);

    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    await runContext.put("analyze_papers.request", {
      topN: 1,
      selectionMode: "top_n",
      selectionPolicy: "hybrid_title_citation_recency_pdf_v2"
    });

    const eventStream = new InMemoryEventStream();
    let rerankCalls = 0;

    let analyzePdfCalls = 0;
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm: {
        complete: async () => {
          rerankCalls += 1;
          overwriteCorpusSync(runId, [enrichedRow, secondRow]);
          return { text: JSON.stringify({ ordered_paper_ids: ["p1", "p2"] }) };
        }
      } as any,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {
        hasApiKey: async () => true,
        analyzePdf: async ({ pdfUrl }: { pdfUrl: string }) => {
          analyzePdfCalls += 1;
          expect(pdfUrl).toBe(enrichedRow.pdf_url);
          return { text: jsonOutput("pdf summary", "pdf claim") };
        }
      } as unknown as ResponsesPdfAnalysisClient
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    expect(rerankCalls).toBe(1);
    expect(analyzePdfCalls).toBe(1);

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    expect(summariesRaw).toContain('"source_type":"full_text"');
    expect(summariesRaw).toContain('"summary":"pdf summary"');
    expect(summariesRaw).not.toContain('"source_type":"abstract"');

    const manifestRaw = await readFile(path.join(".autolabos", "runs", runId, "analysis_manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.papers.p1.pdf_url).toBe(enrichedRow.pdf_url);
    expect(manifest.papers.p1.score_breakdown.pdf_availability_score).toBe(1);

  });

  it("uses recovered PDF metadata from collect_enrichment logs before corpus rewrite completes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-enrichment-log-pdf-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-enrichment-log-pdf";
    const run = makeRun(runId);
    const initialRow = {
      paper_id: "p1",
      title: "Paper 1",
      abstract: "Abstract 1",
      authors: ["Alice"],
      url: "https://example.com/p1"
    };
    await writeCorpus(runId, [initialRow]);
    await writeCollectEnrichment(runId, [
      {
        paper_id: "p1",
        pdf_resolution: {
          source: "landing_page",
          url: "https://example.com/p1.pdf"
        },
        attempts: [{ stage: "landing_page", ok: true }],
        errors: []
      }
    ]);

    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    await runContext.put("analyze_papers.request", {
      topN: 1,
      selectionMode: "top_n",
      selectionPolicy: "hybrid_title_citation_recency_pdf_v2"
    });

    let analyzePdfCalls = 0;
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: {
        complete: async () => ({ text: JSON.stringify({ ordered_paper_ids: ["p1"] }) })
      } as any,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {
        hasApiKey: async () => true,
        analyzePdf: async ({ pdfUrl }: { pdfUrl: string }) => {
          analyzePdfCalls += 1;
          expect(pdfUrl).toBe("https://example.com/p1.pdf");
          return { text: jsonOutput("pdf summary", "pdf claim") };
        }
      } as unknown as ResponsesPdfAnalysisClient
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    expect(analyzePdfCalls).toBe(1);

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    expect(summariesRaw).toContain('"source_type":"full_text"');
    expect(summariesRaw).toContain('"summary":"pdf summary"');
    expect(summariesRaw).not.toContain('"fallback_reason":"no_pdf_url"');

    const manifestRaw = await readFile(path.join(".autolabos", "runs", runId, "analysis_manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.papers.p1.pdf_url).toBe("https://example.com/p1.pdf");
    expect(manifest.papers.p1.source_type).toBe("full_text");
  });

  it("waits for deferred collect enrichment to finish for a small all-mode selection before source resolution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-small-all-wait-"));
    tempDirs.push(root);
    process.chdir(root);
    vi.useFakeTimers();

    const runId = "run-analyze-small-all-wait";
    const run = makeRun(runId);
    const initialRow = {
      paper_id: "p1",
      title: "Paper 1",
      abstract: "Abstract 1",
      authors: ["Alice"],
      url: "https://example.com/p1"
    };
    const enrichedRow = {
      ...initialRow,
      pdf_url: "https://example.com/p1.pdf"
    };
    await writeCorpus(runId, [initialRow]);
    await writeCollectResult(runId, {
      stored: 1,
      pdfRecovered: 0,
      enrichment: {
        status: "pending",
        targetCount: 1,
        processedCount: 0,
        attemptedCount: 0,
        updatedCount: 0
      }
    });

    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    await runContext.put("analyze_papers.request", {
      selectionMode: "all",
      selectionPolicy: "hybrid_title_citation_recency_pdf_v2",
      topN: null
    });

    const enrichmentEntry = {
      paper_id: "p1",
      pdf_resolution: {
        source: "landing_page",
        url: enrichedRow.pdf_url
      },
      attempts: [{ stage: "landing_page", ok: true }],
      errors: []
    };
    setTimeout(() => {
      overwriteCorpusSync(runId, [enrichedRow]);
      overwriteCollectEnrichmentSync(runId, [enrichmentEntry]);
      overwriteCollectResultSync(runId, {
        stored: 1,
        pdfRecovered: 1,
        enrichment: {
          status: "completed",
          targetCount: 1,
          processedCount: 1,
          attemptedCount: 1,
          updatedCount: 1
        }
      });
    }, 6_000);

    let analyzePdfCalls = 0;
    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm: new SequenceJsonLLM(["unused"]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {
        hasApiKey: async () => true,
        analyzePdf: async ({ pdfUrl }: { pdfUrl: string }) => {
          analyzePdfCalls += 1;
          expect(pdfUrl).toBe(enrichedRow.pdf_url);
          return { text: jsonOutput("pdf summary", "pdf claim") };
        }
      } as unknown as ResponsesPdfAnalysisClient
    });

    const resultPromise = node.execute({ run, graph: run.graph });
    await vi.advanceTimersByTimeAsync(6_500);
    const result = await resultPromise;

    expect(result.status).toBe("success");
    expect(analyzePdfCalls).toBe(1);

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    expect(summariesRaw).toContain('"source_type":"full_text"');
    expect(summariesRaw).not.toContain('"fallback_reason":"no_pdf_url"');

    const manifestRaw = await readFile(path.join(".autolabos", "runs", runId, "analysis_manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.papers.p1.pdf_url).toBe(enrichedRow.pdf_url);
    expect(manifest.papers.p1.source_type).toBe("full_text");

  });

  it("retries source resolution after an initial no_pdf_url fallback when collect enrichment finishes slightly later", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-late-fallback-retry-"));
    tempDirs.push(root);
    process.chdir(root);
    vi.useFakeTimers();

    const runId = "run-analyze-late-fallback-retry";
    const paper = {
      paper_id: "p1",
      title: "Paper 1",
      abstract: "Abstract 1",
      authors: ["Alice"],
      url: "https://example.com/p1"
    };
    await writeCorpus(runId, [paper]);
    await writeCollectResult(runId, {
      stored: 1,
      pdfRecovered: 0,
      enrichment: {
        status: "pending",
        targetCount: 1,
        processedCount: 0,
        attemptedCount: 0,
        updatedCount: 0
      }
    });
    writeCachedPaperTextSync(runId, "p1", "Cached article body recovered for analysis");

    setTimeout(() => {
      overwriteCorpusSync(runId, [
        {
          ...paper,
          pdf_url: "https://example.com/p1.pdf"
        }
      ]);
      overwriteCollectResultSync(runId, {
        stored: 1,
        pdfRecovered: 1,
        enrichment: {
          status: "completed",
          targetCount: 1,
          processedCount: 1,
          attemptedCount: 1,
          updatedCount: 1
        }
      });
    }, 100);

    const resultPromise = retryResolvedSourceAfterLatePdfRecovery({
      runId,
      paper,
      source: {
        sourceType: "abstract",
        text: "Abstract 1",
        fullTextAvailable: false,
        fallbackReason: "no_pdf_url"
      },
      includePageImages: false,
      selectionMode: "all",
      selectedCount: 1,
      totalCandidates: 1
    });

    await vi.advanceTimersByTimeAsync(250);
    const retried = await resultPromise;

    expect(retried.paper.pdf_url).toBe("https://example.com/p1.pdf");
    expect(retried.source.sourceType).toBe("full_text");
    expect(retried.source.pdfUrl).toBe("https://example.com/p1.pdf");
    expect(retried.source.text).toBe("Cached article body recovered for analysis");
  });

  it("retries source resolution when collect enrichment replaces a stale PDF URL after an initial abstract fallback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-late-pdf-replacement-"));
    tempDirs.push(root);
    process.chdir(root);
    vi.useFakeTimers();

    const runId = "run-analyze-late-pdf-replacement";
    const paper = {
      paper_id: "p1",
      title: "Paper 1",
      abstract: "Abstract 1",
      authors: ["Alice"],
      pdf_url: "https://broken.example/p1.pdf"
    };
    await writeCorpus(runId, [paper]);
    await writeCollectResult(runId, {
      stored: 1,
      pdfRecovered: 0,
      enrichment: {
        status: "pending",
        targetCount: 1,
        processedCount: 0,
        attemptedCount: 0,
        updatedCount: 0
      }
    });
    writeCachedPaperTextSync(runId, "p1", "Cached article body recovered for analysis");

    const recoveredPdfUrl = "https://example.com/p1.pdf";
    setTimeout(() => {
      overwriteCollectEnrichmentSync(runId, [
        {
          paper_id: "p1",
          pdf_resolution: {
            source: "landing_page",
            url: recoveredPdfUrl
          },
          attempts: [{ stage: "landing_page", ok: true }],
          errors: []
        }
      ]);
      overwriteCollectResultSync(runId, {
        stored: 1,
        pdfRecovered: 1,
        enrichment: {
          status: "completed",
          targetCount: 1,
          processedCount: 1,
          attemptedCount: 1,
          updatedCount: 1
        }
      });
    }, 100);

    const resultPromise = retryResolvedSourceAfterLatePdfRecovery({
      runId,
      paper,
      source: {
        sourceType: "abstract",
        text: "Abstract 1",
        fullTextAvailable: false,
        pdfUrl: paper.pdf_url,
        fallbackReason: "pdf_download_failed:403"
      },
      includePageImages: false,
      selectionMode: "all",
      selectedCount: 1,
      totalCandidates: 1
    });

    await vi.advanceTimersByTimeAsync(250);
    const retried = await resultPromise;

    expect(retried.paper.pdf_url).toBe(recoveredPdfUrl);
    expect(retried.source.sourceType).toBe("full_text");
    expect(retried.source.pdfUrl).toBe(recoveredPdfUrl);
    expect(retried.source.text).toBe("Cached article body recovered for analysis");
  });

  it("waits for in-flight paper persistence before surfacing an abort from a concurrent paper", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-abort-drain-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-abort-drain";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      {
        paper_id: "p1",
        title: "Multi-Agent Collaboration Benchmark",
        abstract: "A benchmark for multi-agent collaboration with measurable gains.",
        authors: ["Alice"]
      },
      {
        paper_id: "p2",
        title: "Abort-only unrelated baseline",
        abstract: "An unrelated baseline that should fail after the first paper persists.",
        authors: ["Bob"]
      }
    ]);

    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new PlannerAwarePaperLlm({
        abortTitle: "Abort-only unrelated baseline",
        summary: "good summary",
        claim: "good claim",
        delayMs: 10
      }),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    // Without a user abortSignal, abort errors from individual papers are
    // treated as per-paper failures (not node-level abort). The node should
    // succeed with partial results.
    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    expect(summariesRaw).toContain('"paper_id":"p1"');
    expect(summariesRaw).not.toContain('"paper_id":"p2"');

    const manifestRaw = await readFile(path.join(".autolabos", "runs", runId, "analysis_manifest.json"), "utf8");
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.papers.p1.status).toBe("completed");
    expect(manifest.papers.p2.status).toBe("failed");
  });

  it("falls back to local text/abstract analysis when Responses API times out downloading a remote PDF", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-pdf-fallback-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-pdf-fallback";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      {
        paper_id: "p1",
        title: "Paper 1",
        abstract: "Abstract 1",
        authors: ["Alice"],
        pdf_url: "https://example.com/p1.pdf"
      }
    ]);

    globalThis.fetch = (async () => new Response("missing", { status: 404 })) as typeof fetch;

    const eventStream = new InMemoryEventStream();
    const responseClient = {
      hasApiKey: async () => true,
      analyzePdf: async () => {
        throw new Error(
          'Responses API request failed: 400 { "error": { "message": "Timeout while downloading https://example.com/p1.pdf" } }'
        );
      }
    } as unknown as ResponsesPdfAnalysisClient;

    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm: new SequenceJsonLLM([jsonOutput("fallback summary", "fallback claim")]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: responseClient
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    expect(summariesRaw).toContain('"summary":"fallback summary"');
    expect(summariesRaw).toContain('"source_type":"abstract"');

    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(loggedTexts.some((text) => text.includes("Responses API could not download the remote PDF"))).toBe(true);
    expect(loggedTexts.some((text) => text.includes("Falling back to abstract for \"Paper 1\" after Responses API fallback"))).toBe(true);
  });

  it("falls back to local text/abstract analysis when Responses API returns upstream 403 while downloading a remote PDF", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-pdf-403-fallback-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-pdf-403-fallback";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      {
        paper_id: "p1",
        title: "Paper 1",
        abstract: "Abstract 1",
        authors: ["Alice"],
        pdf_url: "https://www.proceedings.com/content/079/079017-4397open.pdf"
      }
    ]);

    globalThis.fetch = (async () => new Response("forbidden", { status: 403 })) as typeof fetch;

    const eventStream = new InMemoryEventStream();
    const responseClient = {
      hasApiKey: async () => true,
      analyzePdf: async () => {
        throw new Error(
          'Responses API request failed: 400 { "error": { "message": "Error while downloading https://www.proceedings.com/content/079/079017-4397open.pdf. Upstream status code: 403.", "type": "invalid_request_error", "param": "url" } }'
        );
      }
    } as unknown as ResponsesPdfAnalysisClient;

    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm: new SequenceJsonLLM([jsonOutput("fallback summary", "fallback claim")]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: responseClient
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    expect(summariesRaw).toContain('"summary":"fallback summary"');
    expect(summariesRaw).toContain('"source_type":"abstract"');

    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(loggedTexts.some((text) => text.includes("Responses API could not download the remote PDF"))).toBe(true);
    expect(loggedTexts.some((text) => text.includes("Upstream status code: 403"))).toBe(true);
    expect(loggedTexts.some((text) => text.includes("Falling back to abstract for \"Paper 1\" after Responses API fallback"))).toBe(true);
    expect(loggedTexts.some((text) => text.includes('Analysis failed for "Paper 1"'))).toBe(false);
  });

  it("falls back to local text/abstract analysis when the Responses PDF extractor times out", async () => {
    process.env.AUTOLABOS_ANALYSIS_EXTRACT_TIMEOUT_MS = "10";

    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-pdf-timeout-fallback-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-pdf-timeout-fallback";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      {
        paper_id: "p1",
        title: "Paper 1",
        abstract: "Abstract 1",
        authors: ["Alice"],
        pdf_url: "https://example.com/p1.pdf"
      }
    ]);

    globalThis.fetch = (async () => new Response("missing", { status: 404 })) as typeof fetch;

    const eventStream = new InMemoryEventStream();
    const responseClient = new PlannerThenHangingResponsesPdfClient();

    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm: new SequenceJsonLLM([jsonOutput("fallback summary", "fallback claim")]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: responseClient as unknown as ResponsesPdfAnalysisClient
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    expect(summariesRaw).toContain('"summary":"fallback summary"');
    expect(summariesRaw).toContain('"source_type":"abstract"');
    expect(responseClient.callCount).toBe(2);

    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(loggedTexts.some((text) => text.includes("extractor exceeded the 10ms timeout"))).toBe(true);
    expect(loggedTexts.some((text) => text.includes("Responses API could not download the remote PDF"))).toBe(true);
    expect(loggedTexts.some((text) => text.includes("Falling back to abstract for \"Paper 1\" after Responses API fallback"))).toBe(true);
  });

  it("analyzes only the selected top-N papers when a request is provided", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-topn-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-topn";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      {
        paper_id: "p1",
        title: "Multi-agent collaboration benchmark",
        abstract: "A",
        authors: ["Alice"],
        citation_count: 80,
        year: 2025
      },
      {
        paper_id: "p2",
        title: "Multi-agent planning systems",
        abstract: "B",
        authors: ["Bob"],
        citation_count: 60,
        year: 2024
      },
      {
        paper_id: "p3",
        title: "Irrelevant prior retrieval",
        abstract: "C",
        authors: ["Carol"],
        citation_count: 5,
        year: 2018
      }
    ]);
    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    await runContext.put("analyze_papers.request", {
      topN: 2,
      selectionMode: "top_n",
      selectionPolicy: "hybrid_title_citation_recency_pdf_v2"
    });

    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequenceJsonLLM([
        JSON.stringify({ ordered_paper_ids: ["p2", "p1"] }),
        jsonOutput("summary 2", "claim 2"),
        jsonOutput("summary 1", "claim 1")
      ]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    const manifestRaw = await readFile(path.join(".autolabos", "runs", runId, "analysis_manifest.json"), "utf8");
    expect(summariesRaw.trim().split("\n")).toHaveLength(2);
    expect(summariesRaw).toContain('"paper_id":"p1"');
    expect(summariesRaw).toContain('"paper_id":"p2"');
    expect(summariesRaw).not.toContain('"paper_id":"p3"');
    expect(manifestRaw).toContain('"selectedPaperIds": [');
    expect(manifestRaw).toContain('"p2"');
    expect(manifestRaw).toContain('"selectionFingerprint"');
  });

  it("preserves topic-family coverage in the selected papers and analysis manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-family-coverage-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-family-coverage";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      {
        paper_id: "p1",
        title: "Evidence-grounded evaluation with established protocols",
        abstract: "A common evaluation protocol.",
        authors: ["Alice"],
        citation_count: 100,
        year: 2025,
        query_families: ["topic_family_common"]
      },
      {
        paper_id: "p2",
        title: "Reliable evaluation with repeated measurements",
        abstract: "Another common measurement design.",
        authors: ["Bob"],
        citation_count: 80,
        year: 2025,
        query_families: ["topic_family_common"]
      },
      {
        paper_id: "p3",
        title: "Bounded-resource evaluation failure analysis",
        abstract: "A rare failure axis under limited resources.",
        authors: ["Carol"],
        citation_count: 1,
        year: 2024,
        query_families: ["topic_family_rare"]
      }
    ]);
    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    await runContext.put("analyze_papers.request", {
      topN: 2,
      selectionMode: "top_n",
      selectionPolicy: "hybrid_title_citation_recency_pdf_v2"
    });
    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: { responses_model: "gpt-5.4" }
      } as any,
      runStore: {} as any,
      eventStream,
      llm: new SequenceJsonLLM([
        JSON.stringify({ ordered_paper_ids: ["p1", "p2", "p3"] }),
        jsonOutput("summary common", "claim common"),
        jsonOutput("summary rare", "claim rare")
      ]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    const manifest = JSON.parse(
      await readFile(path.join(".autolabos", "runs", runId, "analysis_manifest.json"), "utf8")
    ) as {
      selectedPaperIds?: string[];
      topicFamilyCoverage?: {
        selectedFamilies?: string[];
        uncoveredFamilies?: string[];
        addedPaperIds?: string[];
        coverageComplete?: boolean;
      };
      papers?: Record<string, { query_families?: string[] }>;
    };
    expect(manifest.selectedPaperIds).toEqual(["p1", "p3"]);
    expect(manifest.topicFamilyCoverage).toMatchObject({
      selectedFamilies: ["topic_family_common", "topic_family_rare"],
      uncoveredFamilies: [],
      addedPaperIds: ["p3"],
      coverageComplete: true
    });
    expect(manifest.papers?.p3?.query_families).toEqual(["topic_family_rare"]);
    expect(
      eventStream.history().some((event) =>
        String(event.payload?.text ?? "").includes("Topic-family coverage selected 2/2")
      )
    ).toBe(true);
  });

  it("records query feedback and backtracks to collection when a family has no analysis-eligible paper", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-family-backtrack-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-family-backtrack";
    const run = makeRun(runId);
    const corpusRows = [
      {
        paper_id: "p1",
        title: "Multi-agent collaboration with structured coordination",
        abstract: "A direct study of multi-agent collaboration.",
        authors: ["Alice"],
        citation_count: 30,
        year: 2025,
        query_families: ["query_family_primary"]
      },
      {
        paper_id: "p2",
        title: "Multi-agent collaboration under repeated evaluation",
        abstract: "A second structured coordination study of multi-agent collaboration.",
        authors: ["Bob"],
        citation_count: 20,
        year: 2024,
        query_families: ["query_family_primary"]
      },
      {
        paper_id: "p3",
        title: "Agricultural irrigation scheduling",
        abstract: "A crop water study using multi-agent collaboration transfer calibration.",
        authors: ["Carol"],
        citation_count: 1,
        year: 2023,
        query_families: ["query_family_secondary"]
      },
      {
        paper_id: "p4",
        title: "Agricultural soil moisture scheduling",
        abstract: "A second crop study using multi-agent collaboration transfer calibration.",
        authors: ["Dana"],
        citation_count: 1,
        year: 2022,
        query_families: ["query_family_secondary"]
      },
      {
        paper_id: "p5",
        title: "Multi-agent collaboration with explicit role allocation",
        abstract: "A third structured coordination study of collaboration.",
        authors: ["Evan"],
        citation_count: 15,
        year: 2024,
        query_families: ["query_family_primary"]
      },
      {
        paper_id: "p6",
        title: "Multi-agent collaboration with bounded coordination",
        abstract: "A fourth structured coordination study of collaboration.",
        authors: ["Fran"],
        citation_count: 10,
        year: 2023,
        query_families: ["query_family_primary"]
      },
      {
        paper_id: "p7",
        title: "Agricultural irrigation allocation",
        abstract: "A third crop study using multi-agent collaboration transfer calibration.",
        authors: ["Gale"],
        citation_count: 1,
        year: 2022,
        query_families: ["query_family_secondary"]
      },
      {
        paper_id: "p8",
        title: "Agricultural soil water allocation",
        abstract: "A fourth crop study using multi-agent collaboration transfer calibration.",
        authors: ["Hari"],
        citation_count: 1,
        year: 2021,
        query_families: ["query_family_secondary"]
      }
    ];
    await writeCorpus(runId, corpusRows);
    const runDir = path.join(".autolabos", "runs", runId);
    const collectAttemptId = "20260102030405678-familybacktrack";
    const secondaryQuery = '"multi agent collaboration" transfer calibration';
    await writeTopicDiscoveryCollectLineage({
      run,
      collectAttemptId,
      rows: corpusRows,
      sharedAnchorTerms: ["multi", "agent", "collaboration"],
      families: [
        {
          queryFamily: "query_family_primary",
          query: '"multi agent collaboration" structured coordination',
          axisTerms: ["structured", "coordination"],
          lens: "Direct study of structured coordination",
          contributionIntent: "method"
        },
        {
          queryFamily: "query_family_secondary",
          query: secondaryQuery,
          axisTerms: ["transfer", "calibration"],
          lens: "Direct study of transfer calibration",
          contributionIntent: "measurement"
        }
      ]
    });
    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    await runContext.put("analyze_papers.request", {
      topN: 2,
      selectionMode: "top_n",
      selectionPolicy: "hybrid_title_citation_recency_pdf_v2"
    });
    const llm = new CountingJsonLLM(["not-json"]);
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: { responses_model: "gpt-5.4" }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });

    expect(result).toMatchObject({
      status: "success",
      needsApproval: true,
      toolCallsUsed: 0,
      transitionRecommendation: {
        action: "backtrack_to_collection",
        targetNode: "collect_papers",
        autoExecutable: true
      }
    });
    expect(llm.callCount).toBe(1);
    const gate = JSON.parse(
      await readFile(path.join(runDir, "analysis", "topic_family_coverage_gate.json"), "utf8")
    ) as {
      topic_family_coverage?: { uncoveredFamilies?: string[] };
      family_candidates?: Array<{
        query_family?: string;
        candidates?: Array<{ paper_id?: string; eligible_after_quality_guard?: boolean }>;
      }>;
      query_plan_feedback?: { rejectedQueries?: string[] };
    };
    expect(gate.topic_family_coverage?.uncoveredFamilies).toEqual(["query_family_secondary"]);
    expect(
      gate.family_candidates
        ?.find((family) => family.query_family === "query_family_secondary")
        ?.candidates
    ).toContainEqual(expect.objectContaining({
      paper_id: "p3",
      eligible_after_quality_guard: false
    }));
    expect(gate.query_plan_feedback?.rejectedQueries).toContain(secondaryQuery);
    const queryFeedback = await runContext.get<{
      rejectedQueries?: string[];
      supportedQueryFamilies?: Array<{ query?: string }>;
    }>("collect_papers.llm_query_plan_feedback");
    expect(queryFeedback?.rejectedQueries).toContain(secondaryQuery);
    expect(queryFeedback?.supportedQueryFamilies).toContainEqual(
      expect.objectContaining({ query: '"multi agent collaboration" structured coordination' })
    );
  });

  it("auto-gates a large corpus to top 30 when no explicit selection request is stored", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-auto-top30-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-auto-top30";
    const run = makeRun(runId);
    await writeCorpus(
      runId,
      Array.from({ length: 31 }, (_, index) => ({
        paper_id: `p${index + 1}`,
        title: `Paper ${index + 1}`,
        abstract: `Abstract ${index + 1}`,
        authors: [`Author ${index + 1}`],
        pdf_url: `https://example.com/p${index + 1}.pdf`
      }))
    );

    let analyzePdfCalls = 0;
    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm: new SequenceJsonLLM([
        JSON.stringify({
          ordered_paper_ids: Array.from({ length: 31 }, (_, index) => `p${index + 1}`)
        })
      ]),
      pdfTextLlm: new SequenceJsonLLM([]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {
        hasApiKey: async () => true,
        analyzePdf: async () => {
          analyzePdfCalls += 1;
          return { text: jsonOutput(`summary ${analyzePdfCalls}`, `claim ${analyzePdfCalls}`) };
        }
      } as unknown as ResponsesPdfAnalysisClient
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
    expect(analyzePdfCalls).toBe(30);

    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    expect(await runContext.get("analyze_papers.request")).toMatchObject({
      topN: 30,
      selectionMode: "top_n"
    });
    expect(await runContext.get("analyze_papers.selected_count")).toBe(30);

    const manifestRaw = await readFile(path.join(".autolabos", "runs", runId, "analysis_manifest.json"), "utf8");
    expect(manifestRaw).toContain('"topN": 30');
  });

  it("reuses cached rerank selection when request and corpus are unchanged", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-rerank-cache-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-rerank-cache";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      {
        paper_id: "p1",
        title: "Paper 1",
        abstract: "Abstract 1",
        authors: ["Alice"],
        pdf_url: "https://example.com/p1.pdf"
      },
      {
        paper_id: "p2",
        title: "Paper 2",
        abstract: "Abstract 2",
        authors: ["Bob"],
        pdf_url: "https://example.com/p2.pdf"
      },
      {
        paper_id: "p3",
        title: "Paper 3",
        abstract: "Abstract 3",
        authors: ["Cara"],
        pdf_url: "https://example.com/p3.pdf"
      }
    ]);

    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    await runContext.put("analyze_papers.request", {
      topN: 1,
      selectionMode: "top_n",
      selectionPolicy: "hybrid_title_citation_recency_pdf_v2"
    });

    const firstRerankLlm = new CountingJsonLLM([
      JSON.stringify({
        ordered_paper_ids: ["p2", "p1", "p3"]
      })
    ]);
    let analyzePdfCalls = 0;
    const firstNode = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: firstRerankLlm,
      pdfTextLlm: new SequenceJsonLLM([]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {
        hasApiKey: async () => true,
        analyzePdf: async () => {
          analyzePdfCalls += 1;
          return { text: jsonOutput("pdf summary", "pdf claim") };
        }
      } as unknown as ResponsesPdfAnalysisClient
    });

    const first = await firstNode.execute({ run, graph: run.graph });
    expect(first.status).toBe("success");
    expect(firstRerankLlm.callCount).toBe(1);
    expect(analyzePdfCalls).toBe(1);

    const secondRerankLlm = new CountingJsonLLM(["should-not-be-used"]);
    const secondEventStream = new InMemoryEventStream();
    const secondNode = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream: secondEventStream,
      llm: secondRerankLlm,
      pdfTextLlm: new SequenceJsonLLM([]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {
        hasApiKey: async () => true,
        analyzePdf: async () => {
          throw new Error("analysis should not rerun");
        }
      } as unknown as ResponsesPdfAnalysisClient
    });

    const second = await secondNode.execute({ run, graph: run.graph });
    expect(second.status).toBe("success");
    expect(secondRerankLlm.callCount).toBe(0);

    const secondLogs = secondEventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(secondLogs.some((text) => text.includes("Reusing cached paper rerank from analysis_manifest.json"))).toBe(true);
    expect(secondLogs.some((text) => text.includes("Preparing LLM rerank for"))).toBe(false);

    const manifestRaw = await readFile(path.join(".autolabos", "runs", runId, "analysis_manifest.json"), "utf8");
    expect(manifestRaw).toContain('"selectionRequestFingerprint"');
    expect(manifestRaw).toContain('"corpusFingerprint"');
  });

  it("keeps the cached paper selection while reanalyzing after an analysis fingerprint change", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-selection-stability-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-selection-stability";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      {
        paper_id: "p1",
        title: "Adaptive decision systems study 1",
        abstract: "A matched evaluation of adaptive decision systems.",
        authors: ["Alice"],
        pdf_url: "https://example.com/p1.pdf"
      },
      {
        paper_id: "p2",
        title: "Adaptive decision systems study 2",
        abstract: "A second matched evaluation of adaptive decision systems.",
        authors: ["Bob"],
        pdf_url: "https://example.com/p2.pdf"
      },
      {
        paper_id: "p3",
        title: "Adaptive decision systems study 3",
        abstract: "A third matched evaluation of adaptive decision systems.",
        authors: ["Cara"],
        pdf_url: "https://example.com/p3.pdf"
      }
    ]);

    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    await runContext.put("analyze_papers.request", {
      topN: 1,
      selectionMode: "top_n",
      selectionPolicy: "hybrid_title_citation_recency_pdf_v2"
    });

    const firstRerankLlm = new CountingJsonLLM([
      JSON.stringify({ ordered_paper_ids: ["p2", "p1", "p3"] })
    ]);
    const firstNode = createAnalyzePapersNode({
      config: {
        providers: {
          llm_mode: "openai_api",
          openai: { model: "model-version-a" }
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: firstRerankLlm,
      pdfTextLlm: new SequenceJsonLLM([]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {
        hasApiKey: async () => true,
        analyzePdf: async () => ({ text: jsonOutput("summary before", "claim before") })
      } as unknown as ResponsesPdfAnalysisClient
    });

    const first = await firstNode.execute({ run, graph: run.graph });
    expect(first.status).toBe("success");
    expect(firstRerankLlm.callCount).toBe(1);

    const secondRerankLlm = new CountingJsonLLM(["selection should be reused"]);
    const secondEventStream = new InMemoryEventStream();
    let secondAnalysisCalls = 0;
    const secondNode = createAnalyzePapersNode({
      config: {
        providers: {
          llm_mode: "openai_api",
          openai: { model: "model-version-b" }
        }
      } as any,
      runStore: {} as any,
      eventStream: secondEventStream,
      llm: secondRerankLlm,
      pdfTextLlm: new SequenceJsonLLM([]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {
        hasApiKey: async () => true,
        analyzePdf: async () => {
          secondAnalysisCalls += 1;
          return { text: jsonOutput("summary after", "claim after") };
        }
      } as unknown as ResponsesPdfAnalysisClient
    });

    const second = await secondNode.execute({ run, graph: run.graph });
    expect(second.status).toBe("success");
    expect(secondRerankLlm.callCount).toBe(0);
    expect(secondAnalysisCalls).toBe(1);

    const manifest = JSON.parse(
      await readFile(path.join(".autolabos", "runs", runId, "analysis_manifest.json"), "utf8")
    ) as { selectedPaperIds: string[] };
    expect(manifest.selectedPaperIds).toEqual(["p2"]);

    const summariesRaw = await readFile(
      path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"),
      "utf8"
    );
    expect(summariesRaw).toContain('"paper_id":"p2"');
    expect(summariesRaw).toContain('"summary":"summary after"');
    expect(summariesRaw).not.toContain('"summary":"summary before"');

    const secondLogs = secondEventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(secondLogs.some((text) => text.includes("Reusing cached paper rerank from analysis_manifest.json"))).toBe(true);
    expect(secondLogs.some((text) => text.includes("Analysis settings changed since the previous run."))).toBe(true);
    expect(secondLogs.some((text) => text.includes("Preparing LLM rerank for"))).toBe(false);
  });

  it("reuses deterministic fallback selection on re-entry (rerankApplied=false)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-determ-reuse-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-determ-reuse";
    const run = makeRun(runId);
    // Use titles that match the run topic (Multi-Agent Collaboration) so quality safeguards pass
    await writeCorpus(runId, [
      { paper_id: "p1", title: "Multi-agent collaboration benchmark", abstract: "A1", authors: ["Alice"], pdf_url: "https://example.com/p1.pdf" },
      { paper_id: "p2", title: "Agent collaboration in planning tasks", abstract: "A2", authors: ["Bob"], pdf_url: "https://example.com/p2.pdf" },
      { paper_id: "p3", title: "Multi-agent coordination systems", abstract: "A3", authors: ["Cara"], pdf_url: "https://example.com/p3.pdf" }
    ]);

    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    await runContext.put("analyze_papers.request", {
      topN: 1,
      selectionMode: "top_n",
      selectionPolicy: "hybrid_title_citation_recency_pdf_v2"
    });

    // First execution: LLM rerank fails → deterministic fallback
    const failingRerankLlm = new FixedErrorLLM(new Error("rerank unavailable"));
    let firstAnalyzePdfCalls = 0;
    const firstNode = createAnalyzePapersNode({
      config: { providers: { llm_mode: "openai_api" }, analysis: { responses_model: "gpt-5.4" } } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: failingRerankLlm,
      pdfTextLlm: new SequenceJsonLLM([]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {
        hasApiKey: async () => true,
        analyzePdf: async () => {
          firstAnalyzePdfCalls += 1;
          return { text: jsonOutput("summary", "claim") };
        }
      } as unknown as ResponsesPdfAnalysisClient
    });

    const first = await firstNode.execute({ run, graph: run.graph });
    expect(first.status).toBe("success");
    expect(firstAnalyzePdfCalls).toBe(1);

    // Verify manifest has rerankApplied=false (deterministic fallback)
    const manifestAfterFirst = JSON.parse(
      await readFile(path.join(".autolabos", "runs", runId, "analysis_manifest.json"), "utf8")
    );
    expect(manifestAfterFirst.rerankApplied).toBe(false);
    expect(manifestAfterFirst.selectedPaperIds.length).toBeGreaterThan(0);

    // Second execution: should reuse the deterministic fallback selection, NOT re-rerank
    const secondRerankLlm = new CountingJsonLLM(["should-not-be-used"]);
    const secondNode = createAnalyzePapersNode({
      config: { providers: { llm_mode: "openai_api" }, analysis: { responses_model: "gpt-5.4" } } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: secondRerankLlm,
      pdfTextLlm: new SequenceJsonLLM([]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {
        hasApiKey: async () => true,
        analyzePdf: async () => { throw new Error("analysis should not rerun"); }
      } as unknown as ResponsesPdfAnalysisClient
    });

    const second = await secondNode.execute({ run, graph: run.graph });
    expect(second.status).toBe("success");
    // Key assertion: the LLM rerank should NOT have been called on re-entry
    expect(secondRerankLlm.callCount).toBe(0);
  });

  it("auto-expands a sparse top-N selection and preserves completed analyses", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-topn-expand-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-topn-expand";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      {
        paper_id: "p1",
        title: "Multi-agent collaboration benchmark",
        abstract: "A",
        authors: ["Alice"],
        citation_count: 80,
        year: 2025
      },
      {
        paper_id: "p2",
        title: "Multi-agent planning systems",
        abstract: "B",
        authors: ["Bob"],
        citation_count: 60,
        year: 2024
      },
      {
        paper_id: "p3",
        title: "Prior retrieval",
        abstract: "C",
        authors: ["Carol"],
        citation_count: 5,
        year: 2018
      }
    ]);
    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    await runContext.put("analyze_papers.request", {
      topN: 1,
      selectionMode: "top_n",
      selectionPolicy: "hybrid_title_citation_recency_pdf_v2"
    });

    const eventStream = new InMemoryEventStream();
    const node = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream,
      llm: new SequenceJsonLLM([
        JSON.stringify({ ordered_paper_ids: ["p1", "p2", "p3"] }),
        jsonOutput("summary 1", "claim 1"),
        JSON.stringify({ ordered_paper_ids: ["p1", "p2", "p3"] }),
        jsonOutput("summary 2", "claim 2")
      ]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const result = await node.execute({ run, graph: run.graph });
    expect(result.status).toBe("success");
    expect(result.summary).toContain("Auto-expanded the analysis window 1 time(s)");

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    expect(summariesRaw.trim().split("\n")).toHaveLength(2);
    expect(summariesRaw.match(/"paper_id":"p1"/g)?.length).toBe(1);
    expect(summariesRaw.match(/"paper_id":"p2"/g)?.length).toBe(1);

    const manifestRaw = await readFile(path.join(".autolabos", "runs", runId, "analysis_manifest.json"), "utf8");
    expect(manifestRaw).toContain('"selectedPaperIds": [');
    expect(manifestRaw).toContain('"p1"');
    expect(manifestRaw).toContain('"p2"');

    expect(await runContext.get("analyze_papers.request")).toMatchObject({
      topN: 2,
      selectionMode: "top_n"
    });
    expect(await runContext.get("analyze_papers.auto_expand_count")).toBe(1);

    const loggedTexts = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(loggedTexts.some((text) => text.includes("Auto-expanding to top 2"))).toBe(true);
    expect(
      loggedTexts.some((text) =>
        text.includes("Expanding analysis selection from top 1 to top 2; preserving completed analyses")
      )
    ).toBe(true);
  });

  it("replaces prior selection outputs when top-N changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-topn-replace-"));
    tempDirs.push(root);
    process.chdir(root);
    await seedCodexOAuthHome(root);

    const runId = "run-analyze-topn-replace";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      { paper_id: "p1", title: "Multi-agent collaboration benchmark", abstract: "A", authors: ["Alice"], citation_count: 80, year: 2025 },
      { paper_id: "p2", title: "Multi-agent planning systems", abstract: "B", authors: ["Bob"], citation_count: 60, year: 2024 },
      { paper_id: "p3", title: "Prior retrieval", abstract: "C", authors: ["Carol"], citation_count: 5, year: 2018 }
    ]);

    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    await runContext.put("analyze_papers.request", {
      topN: 2,
      selectionMode: "top_n",
      selectionPolicy: "hybrid_title_citation_recency_pdf_v2"
    });

    const firstNode = createAnalyzePapersNode({
      config: {
        providers: makeCodexProviderConfig(),
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequenceJsonLLM([
        JSON.stringify({ ordered_paper_ids: ["p1", "p2"] }),
        jsonOutput("summary 1", "claim 1"),
        jsonOutput("summary 2", "claim 2")
      ]),
      codex: makeCodexReadyStub(),
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });
    const first = await firstNode.execute({ run, graph: run.graph });
    expect(first.status).toBe("success");

    await runContext.put("analyze_papers.request", {
      topN: 1,
      selectionMode: "top_n",
      selectionPolicy: "hybrid_title_citation_recency_pdf_v2"
    });
    const secondNode = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequenceJsonLLM([
        JSON.stringify({ ordered_paper_ids: ["p2", "p1", "p3"] }),
        jsonOutput("summary new", "claim new")
      ]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });
    const second = await secondNode.execute({ run, graph: run.graph });
    expect(second.status).toBe("success");

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    const evidenceRaw = await readFile(path.join(".autolabos", "runs", runId, "evidence_store.jsonl"), "utf8");
    expect(summariesRaw.trim().split("\n")).toHaveLength(1);
    expect(evidenceRaw.trim().split("\n")).toHaveLength(1);
    expect(summariesRaw).toContain('"paper_id":"p2"');
    expect(summariesRaw).not.toContain('"paper_id":"p1"');
  }, 20000);

  it("re-analyzes papers when the analysis mode fingerprint changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-mode-change-"));
    tempDirs.push(root);
    process.chdir(root);
    await seedCodexOAuthHome(root);

    const runId = "run-analyze-mode-change";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      {
        paper_id: "p1",
        title: "Paper 1",
        abstract: "Abstract 1",
        authors: ["Alice"],
        pdf_url: "https://example.com/p1.pdf"
      }
    ]);

    globalThis.fetch = (async () => new Response("missing", { status: 404 })) as typeof fetch;

    const firstNode = createAnalyzePapersNode({
      config: {
        providers: makeCodexProviderConfig(),
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequenceJsonLLM([jsonOutput("local summary", "local claim")]),
      codex: makeCodexReadyStub(),
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const first = await firstNode.execute({ run, graph: run.graph });
    expect(first.status).toBe("success");

    let analyzePdfCalls = 0;
    const secondEventStream = new InMemoryEventStream();
    const secondNode = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream: secondEventStream,
      llm: new SequenceJsonLLM(["should-not-be-used"]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {
        hasApiKey: async () => true,
        analyzePdf: async () => {
          analyzePdfCalls += 1;
          return { text: jsonOutput("pdf summary", "pdf claim") };
        }
      } as unknown as ResponsesPdfAnalysisClient
    });

    const second = await secondNode.execute({ run, graph: run.graph });
    expect(second.status).toBe("success");
    expect(analyzePdfCalls).toBe(1);

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    expect(summariesRaw.trim().split("\n")).toHaveLength(1);
    expect(summariesRaw).toContain('"summary":"pdf summary"');
    expect(summariesRaw).toContain('"source_type":"full_text"');
    expect(summariesRaw).not.toContain('"summary":"local summary"');
    const loggedTexts = secondEventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(loggedTexts.some((text) => text.includes("Analysis settings changed since the previous run."))).toBe(true);
  });

  it("repairs missing output artifacts and restores downstream hypothesis generation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-analyze-repair-"));
    tempDirs.push(root);
    process.chdir(root);

    const runId = "run-analyze-repair";
    const run = makeRun(runId);
    await writeCorpus(runId, [
      { paper_id: "p1", title: "Paper 1", abstract: "Abstract 1", authors: ["Alice"] }
    ]);

    const firstNode = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new SequenceJsonLLM([jsonOutput("summary 1", "claim 1")]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const first = await firstNode.execute({ run, graph: run.graph });
    expect(first.status).toBe("success");

    await rm(path.join(".autolabos", "runs", runId, "evidence_store.jsonl"), { force: true });

    const secondEventStream = new InMemoryEventStream();
    const secondNode = createAnalyzePapersNode({
      config: {
        providers: { llm_mode: "openai_api" },
        analysis: {
          responses_model: "gpt-5.4"
        }
      } as any,
      runStore: {} as any,
      eventStream: secondEventStream,
      llm: new SequenceJsonLLM([jsonOutput("summary repaired", "claim repaired")]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: new ResponsesPdfAnalysisClient(async () => undefined)
    });

    const second = await secondNode.execute({ run, graph: run.graph });
    expect(second.status).toBe("success");

    const summariesRaw = await readFile(path.join(".autolabos", "runs", runId, "paper_summaries.jsonl"), "utf8");
    const evidenceRaw = await readFile(path.join(".autolabos", "runs", runId, "evidence_store.jsonl"), "utf8");
    expect(summariesRaw.trim().split("\n")).toHaveLength(1);
    expect(evidenceRaw.trim().split("\n")).toHaveLength(1);
    expect(summariesRaw).toContain('"summary":"summary repaired"');
    expect(summariesRaw).not.toContain('"summary":"summary 1"');

    const analyzeLogs = secondEventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(analyzeLogs.some((text) => text.includes("Detected inconsistent analysis artifacts."))).toBe(true);
    expect(analyzeLogs.some((text) => text.includes("Re-queueing 1 completed paper(s)"))).toBe(true);

    const hypothesisOutputs = hypothesisPipelineOutputs("ev_p1_1");
    const hypothesisProposer = new SequenceJsonLLM(
      hypothesisOutputs.slice(0, 4)
    );
    const hypothesisReviewer = new SequenceJsonLLM([
      hypothesisOutputs[4] || ""
    ]);
    const generateNode = createGenerateHypothesesNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: hypothesisProposer,
      pdfTextLlm: new SequenceJsonLLM([]),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    }, {
      proposerIdentity: { identity: "fixture_proposer" },
      reviewer: {
        llm: hypothesisReviewer,
        identity: { identity: "fixture_reviewer" }
      }
    });

    const generated = await generateNode.execute({ run, graph: run.graph });
    expect(generated.status).toBe("success");

    const hypothesesRaw = await readFile(path.join(".autolabos", "runs", runId, "hypotheses.jsonl"), "utf8");
    expect(hypothesesRaw.trim().split("\n").length).toBeGreaterThan(0);
    expect(hypothesesRaw).toContain('"evidence_links":["ev_p1_1"]');
    expect(hypothesesRaw).toContain('"paper_titles":["Paper 1"]');
  });
});
