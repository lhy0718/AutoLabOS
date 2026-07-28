import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";

import {
  createGenerateHypothesesNode,
  normalizeGenerateHypothesesRequest,
  prepareCandidatePriorSearchDecision
} from "../src/core/nodes/generateHypotheses.js";
import { InMemoryEventStream } from "../src/core/events.js";
import { MockLLMClient } from "../src/core/llm/client.js";
import { RunContextMemory } from "../src/core/memory/runContextMemory.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import {
  RESEARCH_FUNNEL_SOURCE_ARTIFACT_PATHS,
  buildResearchGapMap,
  hashCanonical,
  validateResearchFunnelClosedChain
} from "../src/core/researchFunnel.js";
import {
  RESEARCH_GAP_SYNTHESIS_PROMPT_CONTRACT_VERSION,
  RESEARCH_GAP_SYNTHESIS_SEMANTICS_VERSION,
  type ResearchGapSemanticCluster,
  type ResearchGapSynthesisArtifact
} from "../src/core/analysis/researchGapSynthesis.js";
import { PRIOR_ABSORPTION_AXES } from "../src/core/priorAbsorption.js";
import {
  buildCandidatePriorSearchReceipt,
  validateCandidatePriorSearchPlanIntegrity,
  type CandidatePriorSearchPlan
} from "../src/core/candidatePriorSearch.js";
import type { HypothesisEvidenceSeed } from "../src/core/analysis/researchPlanning.js";
import { RunRecord } from "../src/types.js";
import { makeTopicProbeComputeBudgetDeclaration } from "./support/topicProbeComputeBudget.js";

const ORIGINAL_CWD = process.cwd();

class QueueJsonLLMClient extends MockLLMClient {
  private index = 0;

  constructor(private readonly outputs: string[]) {
    super();
  }

  override async complete(prompt: string): Promise<{ text: string }> {
    const axisVerificationOutput = buildAxisVerificationOutput(prompt);
    if (axisVerificationOutput) {
      return { text: axisVerificationOutput };
    }
    const semanticAuditOutput = buildTopicMemorySemanticAuditOutput(prompt);
    if (semanticAuditOutput) {
      return { text: semanticAuditOutput };
    }
    const output = this.outputs[Math.min(this.index, this.outputs.length - 1)] ?? "";
    this.index += 1;
    return { text: output };
  }
}

class BlockingQueueJsonLLMClient extends MockLLMClient {
  private index = 0;

  constructor(
    private readonly outputs: string[],
    private readonly blockedCallIndex: number,
    private readonly gate: Promise<void>
  ) {
    super();
  }

  override async complete(prompt: string): Promise<{ text: string }> {
    const axisVerificationOutput = buildAxisVerificationOutput(prompt);
    if (axisVerificationOutput) {
      return { text: axisVerificationOutput };
    }
    const semanticAuditOutput = buildTopicMemorySemanticAuditOutput(prompt);
    if (semanticAuditOutput) {
      return { text: semanticAuditOutput };
    }
    const currentIndex = this.index;
    const output = this.outputs[Math.min(currentIndex, this.outputs.length - 1)] ?? "";
    this.index += 1;
    if (currentIndex === this.blockedCallIndex) {
      await this.gate;
    }
    return { text: output };
  }
}

class QueueProgressThenHangLLMClient extends MockLLMClient {
  private index = 0;

  constructor(private readonly partialOutputs: string[]) {
    super();
  }

  override async complete(
    _prompt: string,
    opts?: { onProgress?: (event: { type: "status" | "delta"; text: string }) => void; abortSignal?: AbortSignal }
  ): Promise<{ text: string }> {
    const partial = this.partialOutputs[Math.min(this.index, this.partialOutputs.length - 1)] ?? "";
    this.index += 1;
    if (partial) {
      opts?.onProgress?.({ type: "delta", text: partial });
    }
    return await new Promise<{ text: string }>((_, reject) => {
      opts?.abortSignal?.addEventListener(
        "abort",
        () => reject(new Error("Operation aborted by user")),
        { once: true }
      );
    });
  }
}

class FailIfCalledLLMClient extends MockLLMClient {
  override async complete(): Promise<{ text: string }> {
    throw new Error("LLM should not be called");
  }
}

function buildAxisVerificationOutput(prompt: string): string | undefined {
  const marker = "Targets:\n";
  if (
    !prompt.startsWith("Act as the context-isolated axis relation verifier")
    || !prompt.includes(marker)
  ) {
    return undefined;
  }
  const targets = JSON.parse(prompt.split(marker)[1] || "[]") as Array<{
    candidate_id: string;
    prior_paper_id: string;
    axis: string;
    reported_relation: string;
    verification_input_sha256: string;
  }>;
  return JSON.stringify({
    verifications: targets.map((target) => ({
      candidate_id: target.candidate_id,
      prior_paper_id: target.prior_paper_id,
      axis: target.axis,
      reported_relation: target.reported_relation,
      verification_input_sha256: target.verification_input_sha256,
      verdict: "supported",
      rationale: `The supplied positions and span support ${target.axis}.`
    }))
  });
}

function buildTopicMemorySemanticAuditOutput(
  prompt: string
): string | undefined {
  if (!prompt.startsWith("Audit semantic topic identity")) {
    return undefined;
  }
  const payloadText = prompt.slice(prompt.lastIndexOf("\n\n") + 2);
  const payload = JSON.parse(payloadText) as {
    prior_records?: Array<{ record_sha256?: string }>;
  };
  return JSON.stringify({
    comparisons: (payload.prior_records ?? []).map((record) => ({
      prior_record_sha256: record.record_sha256,
      contribution_object_relation: "distinct",
      method_mechanism_relation: "distinct",
      rationale: "The fixture candidate changes both governed core axes."
    }))
  });
}

function topicMeasurementContract(candidateLabel = "reference") {
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
    contribution_claim:
      `The ${candidateLabel} comparison identifies a prespecified boundary absent from the closest priors.`,
    minimum_publishable_evidence: "Repeated comparisons with uncertainty intervals and failure analysis."
  };
}

afterEach(() => {
  delete process.env.AUTOLABOS_HYPOTHESIS_TIMEOUT_MS;
  process.chdir(ORIGINAL_CWD);
});

function buildGapSynthesisFixture(input: {
  runId: string;
  researchCycle: number;
  collectAttemptId: string;
  corpusSha256: string;
  evidenceSha256: string;
  evidence: HypothesisEvidenceSeed[];
  acceptedClusters: ResearchGapSemanticCluster[];
}): ResearchGapSynthesisArtifact {
  const assignedEvidenceIds = new Set(
    input.acceptedClusters.flatMap((cluster) => cluster.evidence_ids)
  );
  const payload: Omit<ResearchGapSynthesisArtifact, "content_sha256"> = {
    schema_version: 2,
    artifact_kind: "research_gap_semantic_synthesis",
    semantics_version: RESEARCH_GAP_SYNTHESIS_SEMANTICS_VERSION,
    prompt_contract_version: RESEARCH_GAP_SYNTHESIS_PROMPT_CONTRACT_VERSION,
    status: "completed",
    method: "llm_proposer_reviewer_deterministic_validation",
    run_id: input.runId,
    research_cycle: input.researchCycle,
    collect_attempt_id: input.collectAttemptId,
    corpus_sha256: input.corpusSha256,
    evidence_sha256: input.evidenceSha256,
    generated_at: "2026-01-01T00:00:00.000Z",
    excluded_evidence: [],
    proposed_clusters: input.acceptedClusters.map((cluster) => ({
      ...cluster,
      rationale: "The fixture links independently grounded scientific limitations."
    })),
    reviews: input.acceptedClusters.map((cluster) => ({
      cluster_id: cluster.cluster_id,
      opportunity_type: cluster.opportunity_type,
      decision: "accept",
      accepted_evidence_ids: cluster.evidence_ids,
      validated_conditions: cluster.opportunity_type === "explicit_limitation"
        ? ["same_unresolved_limitation"]
        : [],
      reason: "The fixture reviewer accepted the independently supported cluster."
    })),
    accepted_clusters: input.acceptedClusters,
    unclustered_evidence_ids: input.evidence
      .map((item) => item.evidence_id)
      .filter((evidenceId): evidenceId is string => Boolean(evidenceId && !assignedEvidenceIds.has(evidenceId))),
    diagnostics: {
      eligible_evidence_count: input.evidence.length,
      eligible_evidence_count_by_opportunity_type: {
        explicit_limitation: input.evidence.length,
        cross_paper_result_disagreement: 0,
        boundary_or_transfer_mismatch: 0,
        missing_comparator_or_control: 0,
        reproducibility_gap: 0
      },
      accepted_cluster_count_by_opportunity_type: {
        explicit_limitation: input.acceptedClusters.filter(
          (cluster) => cluster.opportunity_type === "explicit_limitation"
        ).length,
        cross_paper_result_disagreement: 0,
        boundary_or_transfer_mismatch: 0,
        missing_comparator_or_control: 0,
        reproducibility_gap: 0
      }
    }
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

function makeRun(runId: string): RunRecord {
  return {
    version: 3,
    workflowVersion: 3,
    id: runId,
    title: "Recent Multi-Agent Collaboration Papers",
    topic: "Multi-agent collaboration",
    constraints: ["recent papers", "last 5 years"],
    objectiveMetric: "primary_score",
    status: "running",
    currentNode: "generate_hypotheses",
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

async function prepareSupportedTopicDiscoveryInputs(run: RunRecord): Promise<{
  runDir: string;
  corpusRaw: string;
  collectAttemptId: string;
}> {
  const runDir = path.join(process.cwd(), ".autolabos", "runs", run.id);
  await mkdir(path.join(runDir, "memory"), { recursive: true });
  const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
  await runContext.put(
    "run_brief.raw",
    [
      "# Research Brief",
      "",
      "## Research Mode",
      "`topic_discovery`",
      "",
      "## Allowed Budgeted Passes",
      '- Machine-readable compute ceiling: `{"bounded_probe":{"max_gpu_hours":2,"max_concurrent_gpus":1,"max_trials":6},"confirmatory":{"max_gpu_hours":8,"max_concurrent_gpus":1,"max_trials":18}}`'
    ].join("\n")
  );
  const evidenceRows = [
    {
      evidence_id: "ev_1",
      paper_id: "paper_1",
      canonical_work_id: "work_paper_1",
      claim: "Structured communication reduces ambiguity.",
      evidence_span:
        "Structured communication reduces ambiguity, while the comparison omits an independent evaluation partition.",
      limitation_slot: "The comparison omits an independent evaluation partition.",
      limitation_kind: "scientific" as const,
      method_slot: "The prior uses a structured communication intervention.",
      dataset_slot: "evaluation_fixture_a",
      metric_slot: "primary_variance",
      result_slot: "The intervention reduces ambiguity in the reported setting.",
      source_type: "full_text" as const,
      source_scope: "full_text_excerpt" as const,
      grounding_status: "grounded_span" as const,
      confidence: 0.95,
      confidence_reason: "The evidence span is grounded in the source."
    },
    {
      evidence_id: "ev_2",
      paper_id: "paper_2",
      canonical_work_id: "work_paper_2",
      claim: "Execution feedback improves iterative correction.",
      evidence_span:
        "Execution feedback improves iterative correction, while the comparison omits an independent evaluation partition.",
      limitation_slot: "The comparison omits an independent evaluation partition.",
      limitation_kind: "scientific" as const,
      method_slot: "The prior uses iterative execution feedback.",
      dataset_slot: "evaluation_fixture_b",
      metric_slot: "execution_consistency",
      result_slot: "The intervention improves iterative correction in the reported setting.",
      source_type: "full_text" as const,
      source_scope: "full_text_excerpt" as const,
      grounding_status: "grounded_span" as const,
      confidence: 0.94,
      confidence_reason: "The evidence span is grounded in the source."
    }
  ];
  const evidenceRaw = evidenceRows.map((item) => JSON.stringify(item)).join("\n") + "\n";
  const corpusRaw = [
    JSON.stringify({ paper_id: "paper_1", title: "Paper One" }),
    JSON.stringify({ paper_id: "paper_2", title: "Paper Two" })
  ].join("\n") + "\n";
  const collectAttemptId = "20260102030405678-priorsearchsource";
  await writeFile(path.join(runDir, "evidence_store.jsonl"), evidenceRaw, "utf8");
  await writeFile(path.join(runDir, "corpus.jsonl"), corpusRaw, "utf8");
  await writeFile(
    path.join(runDir, "collect_generation.json"),
    JSON.stringify({
      version: 1,
      kind: "collect_generation",
      run_id: run.id,
      collect_attempt_id: collectAttemptId,
      started_at: "2026-01-02T03:04:05.678Z"
    }),
    "utf8"
  );
  await mkdir(path.join(runDir, "analysis"), { recursive: true });
  const corpusSha256 = createHash("sha256").update(corpusRaw, "utf8").digest("hex");
  const evidenceSha256 = createHash("sha256").update(evidenceRaw, "utf8").digest("hex");
  const gapStatement = "The comparison omits an independent evaluation partition.";
  const gapSynthesis = buildGapSynthesisFixture({
    runId: run.id,
    researchCycle: run.graph.researchCycle,
    collectAttemptId,
    corpusSha256,
    evidenceSha256,
    evidence: evidenceRows,
    acceptedClusters: [{
      cluster_id: "gap_cluster_prior_search",
      opportunity_type: "explicit_limitation",
      statement: gapStatement,
      evidence_ids: ["ev_1", "ev_2"],
      paper_ids: ["paper_1", "paper_2"]
    }]
  });
  await writeFile(
    path.join(runDir, "analysis", "gap_synthesis.json"),
    JSON.stringify(gapSynthesis, null, 2),
    "utf8"
  );
  await writeFile(
    path.join(runDir, "analysis", "gap_map.json"),
    JSON.stringify(buildResearchGapMap({
      evidence: evidenceRows,
      semanticClusters: [{
        statement: gapStatement,
        evidence_ids: ["ev_1", "ev_2"],
        opportunity_type: "explicit_limitation"
      }],
      synthesisBinding: {
        content_sha256: gapSynthesis.content_sha256,
        semantics_version: gapSynthesis.semantics_version,
        status: gapSynthesis.status
      },
      analysisCoverage: {
        selected_paper_count: 2,
        completed_paper_count: 2,
        failed_paper_ids: [],
        complete: true
      },
      runId: run.id,
      researchCycle: run.graph.researchCycle,
      collectAttemptId,
      corpusSha256,
      corpusByteLength: Buffer.byteLength(corpusRaw, "utf8"),
      evidenceSha256,
      evidenceByteLength: Buffer.byteLength(evidenceRaw, "utf8")
    }), null, 2),
    "utf8"
  );
  return { runDir, corpusRaw, collectAttemptId };
}

async function persistCompletedCandidatePriorSearch(input: {
  runDir: string;
  corpusRaw: string;
  collectAttemptId: string;
  plan: CandidatePriorSearchPlan;
}): Promise<void> {
  const selectedPaperId = "paper_1";
  const plannedFamilyIds = input.plan.candidates.flatMap((candidate) =>
    candidate.families.map((family) => family.family_id)
  );
  const resultCorpusRaw = input.corpusRaw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map((row) =>
      row.paper_id === selectedPaperId
        ? { ...row, query_families: plannedFamilyIds }
        : row
    )
    .map((row) => JSON.stringify(row))
    .join("\n") + "\n";
  const sourceArchiveDir = path.join(
    input.runDir,
    "collect_attempts",
    input.plan.source_corpus.collect_attempt_id
  );
  await mkdir(sourceArchiveDir, { recursive: true });
  await writeFile(
    path.join(sourceArchiveDir, "corpus.jsonl"),
    input.corpusRaw,
    "utf8"
  );
  await writeFile(
    path.join(input.runDir, "corpus.jsonl"),
    resultCorpusRaw,
    "utf8"
  );
  const gapSynthesisPath = path.join(
    input.runDir,
    "analysis",
    "gap_synthesis.json"
  );
  const gapSynthesis = JSON.parse(
    await readFile(gapSynthesisPath, "utf8")
  ) as Record<string, unknown>;
  gapSynthesis.corpus_sha256 = createHash("sha256")
    .update(resultCorpusRaw, "utf8")
    .digest("hex");
  const { content_sha256: _gapSynthesisHash, ...gapSynthesisPayload } =
    gapSynthesis;
  gapSynthesis.content_sha256 = hashCanonical(gapSynthesisPayload);
  await writeFile(
    gapSynthesisPath,
    JSON.stringify(gapSynthesis, null, 2),
    "utf8"
  );
  const gapMapPath = path.join(input.runDir, "analysis", "gap_map.json");
  const gapMap = JSON.parse(
    await readFile(gapMapPath, "utf8")
  ) as Record<string, any>;
  gapMap.corpus_sha256 = gapSynthesis.corpus_sha256;
  gapMap.corpus_byte_length = Buffer.byteLength(resultCorpusRaw, "utf8");
  gapMap.synthesis_binding.content_sha256 = gapSynthesis.content_sha256;
  const { content_sha256: _gapMapHash, ...gapMapPayload } = gapMap;
  gapMap.content_sha256 = hashCanonical(gapMapPayload);
  await writeFile(gapMapPath, JSON.stringify(gapMap, null, 2), "utf8");
  const receipt = buildCandidatePriorSearchReceipt({
    plan: input.plan,
    collectAttemptId: input.collectAttemptId,
    generatedAt: "2026-01-02T04:05:06.789Z",
    resultCorpusSha256: createHash("sha256").update(resultCorpusRaw, "utf8").digest("hex"),
    resultCorpusByteLength: Buffer.byteLength(resultCorpusRaw, "utf8"),
    attempts: input.plan.candidates.flatMap((candidate) =>
      candidate.families.flatMap((family) =>
        family.lanes.map((lane) => ({
          familyId: family.family_id,
          retrievalLane: lane.retrieval_lane,
          query: family.query,
          fetched: lane.retrieval_lane === "broad_relevance" ? 1 : 0,
          selected: lane.retrieval_lane === "broad_relevance" ? 1 : 0,
          selectedPaperIds:
            lane.retrieval_lane === "broad_relevance"
              ? [selectedPaperId]
              : []
        }))
      )
    )
  });
  await writeFile(
    path.join(input.runDir, "collect_query_plan.json"),
    JSON.stringify({
      collect_attempt_id: input.collectAttemptId,
      strategy: "candidate_prior_portfolio",
      candidate_prior_search_plan: input.plan
    }),
    "utf8"
  );
  await writeFile(
    path.join(input.runDir, "collect_candidate_prior_search_plan.json"),
    JSON.stringify(input.plan),
    "utf8"
  );
  await writeFile(
    path.join(input.runDir, "collect_candidate_prior_search_receipt.json"),
    JSON.stringify(receipt),
    "utf8"
  );
}

function stagedHypothesisOutputs(): string[] {
  return [
    JSON.stringify({
      summary: "Mapped evidence into two axes.",
      axes: [
        {
          id: "ax_1",
          label: "Structured communication",
          mechanism: "Schemas reduce ambiguous message interpretation.",
          intervention: "Constrain inter-agent messages to typed fields.",
          boundary_condition: "Smaller gains when interfaces are already deterministic.",
          evaluation_hint: "Measure variance across repeated runs.",
          evidence_links: ["ev_1"]
        },
        {
          id: "ax_2",
          label: "Execution feedback",
          mechanism: "Validator-backed correction reduces error cascades.",
          intervention: "Add bounded execute-test-repair loops.",
          boundary_condition: "Less useful when validation is expensive.",
          evaluation_hint: "Measure failure mode stability.",
          evidence_links: ["ev_2"]
        }
      ]
    }),
    JSON.stringify({
      summary: "Generated mechanism drafts.",
      candidates: [
        {
          id: "cand_1",
          text: "Typed message schemas will reduce run-to-run variance relative to free-form chat on code-generation benchmarks.",
          novelty: 4,
          feasibility: 4,
          testability: 5,
          cost: 2,
          expected_gain: 5,
          evidence_links: ["ev_1", "ev_2"],
          axis_ids: ["ax_1"],
          rationale: "Direct intervention against ambiguous coordination.",
          ...topicMeasurementContract("mechanism")
        }
      ]
    }),
    JSON.stringify({
      summary: "Generated contradiction drafts.",
      candidates: [
        {
          id: "cand_2",
          text: "Role decomposition only improves reproducibility on tasks with stable task boundaries.",
          novelty: 4,
          feasibility: 3,
          testability: 3,
          cost: 2,
          expected_gain: 3,
          evidence_links: ["ev_1", "ev_2"],
          axis_ids: ["ax_1"],
          rationale: "Task structure likely moderates benefit.",
          ...topicMeasurementContract("contradiction")
        }
      ]
    }),
    JSON.stringify({
      summary: "Generated intervention drafts.",
      candidates: [
        {
          id: "cand_3",
          text: "Bounded execute-test-repair loops will improve reproducibility more than extra peer discussion.",
          novelty: 4,
          feasibility: 5,
          testability: 5,
          cost: 2,
          expected_gain: 5,
          evidence_links: ["ev_1", "ev_2"],
          axis_ids: ["ax_2"],
          rationale: "Execution-backed correction is directly testable.",
          ...topicMeasurementContract("intervention")
        }
      ]
    }),
    JSON.stringify({
      summary: "Shortlisted the strongest bounded probe drafts.",
      reviews: [
        {
          candidate_id: "mechanism_1",
          keep: true,
          groundedness: 5,
          causal_clarity: 5,
          falsifiability: 5,
          experimentability: 5,
          measurement_specificity: 5,
          measurement_signals: ["run_to_run_variance"],
          measurement_hint: "Measure run-to-run variance across repeated seeded runs.",
          limitation_reflection: 4,
          measurement_readiness: 5,
          strengths: ["Clear baseline and intervention."],
          weaknesses: ["Benchmark-specific."],
          critique_summary: "Strong."
        },
        {
          candidate_id: "contradiction_1",
          keep: false,
          groundedness: 3,
          causal_clarity: 3,
          falsifiability: 2,
          experimentability: 2,
          measurement_specificity: 2,
          measurement_signals: [],
          limitation_reflection: 2,
          measurement_readiness: 1,
          strengths: ["Interesting boundary condition."],
          weaknesses: ["Still underspecified."],
          critique_summary: "Needs more operational detail."
        },
        {
          candidate_id: "intervention_1",
          keep: true,
          groundedness: 5,
          causal_clarity: 5,
          falsifiability: 5,
          experimentability: 5,
          measurement_specificity: 5,
          measurement_signals: ["failure_mode_stability", "run_to_run_variance"],
          measurement_hint: "Track failure-mode stability and repeated-run variance.",
          limitation_reflection: 4,
          measurement_readiness: 5,
          strengths: ["Directly implementable."],
          weaknesses: ["Adds execution cost."],
          critique_summary: "Excellent."
        }
      ]
    }),
    JSON.stringify({
      assessments: ["mechanism_1", "contradiction_1", "intervention_1"].flatMap(
        (candidateId) =>
          [
            { priorPaperId: "paper_1", evidenceId: "ev_1" },
            { priorPaperId: "paper_2", evidenceId: "ev_2" }
          ].map(({ priorPaperId, evidenceId }) => ({
            candidate_id: candidateId,
            prior_paper_id: priorPaperId,
            disposition: "non_overlapping",
            axes: PRIOR_ABSORPTION_AXES.map((axis) => ({
              axis,
              relation: "distinct",
              evidence_ids: [evidenceId]
            })),
            independent_evidence_ids: ["ev_1", "ev_2"]
          }))
      )
    })
  ];
}

function independentReviewDependencies(reviewer: MockLLMClient) {
  return {
    proposerIdentity: {
      backend: "fixture_backend",
      provider: "fixture_provider",
      model: "fixture_proposer_model"
    },
    reviewer: {
      llm: reviewer,
      identity: {
        backend: "fixture_backend",
        provider: "fixture_provider",
        model: "fixture_reviewer_model"
      },
      topicMemoryTransmissionPolicy: {
        reviewer_trust_class: "local",
        payload_mode: "raw_descriptors",
        raw_descriptor_consent: true
      }
    }
  };
}

function stagedHypothesisClients() {
  const outputs = stagedHypothesisOutputs();
  const proposer = new QueueJsonLLMClient([
    ...outputs.slice(0, 4),
    outputs[5] || ""
  ]);
  const reviewer = new QueueJsonLLMClient([outputs[4] || ""]);
  return {
    proposer,
    reviewDependencies: independentReviewDependencies(reviewer)
  };
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function waitForText(filePath: string, predicate: (text: string) => boolean): Promise<string> {
  let lastText = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      lastText = await readFile(filePath, "utf8");
      if (predicate(lastText)) {
        return lastText;
      }
    } catch {
      // wait for the artifact to appear
    }
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${filePath}. Last text: ${lastText}`);
}


describe("normalizeGenerateHypothesesRequest", () => {
  it("uses defaults when values are missing", () => {
    expect(normalizeGenerateHypothesesRequest(undefined)).toEqual({
      topK: 2,
      branchCount: 6
    });
  });

  it("ensures branch-count is at least top-k", () => {
    expect(normalizeGenerateHypothesesRequest({ topK: 5, branchCount: 3 })).toEqual({
      topK: 5,
      branchCount: 5
    });
  });

  it("persists same-client self-review provenance and blocks topic-probe authorization", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-review-boundary-"));
    process.chdir(root);
    const run = makeRun("run-review-boundary");
    const { runDir } = await prepareSupportedTopicDiscoveryInputs(run);
    const llm = new QueueJsonLLMClient(stagedHypothesisOutputs());
    const node = createGenerateHypothesesNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      pdfTextLlm: llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    }, {
      proposerIdentity: { identity: "fixture_proposer" },
      reviewer: {
        llm,
        identity: { identity: "fixture_reviewer" }
      }
    });

    const result = await node.execute({ run, graph: run.graph });
    const provenance = JSON.parse(await readFile(
      path.join(runDir, "hypothesis_generation", "review_provenance.json"),
      "utf8"
    )) as {
      review_authorization?: {
        independence_class?: string;
        authorized_for_probe?: boolean;
        reason_codes?: string[];
      };
    };
    const reviews = (await readFile(
      path.join(runDir, "hypothesis_generation", "reviews.jsonl"),
      "utf8"
    )).trim().split("\n").map((line) => JSON.parse(line)) as Array<{
      provenance?: { independence_class?: string };
    }>;
    const shortlist = JSON.parse(await readFile(
      path.join(runDir, "hypothesis_generation", "probe_shortlist.json"),
      "utf8"
    )) as {
      probe_candidate_ids?: string[];
      review_authorization?: { authorized_for_probe?: boolean };
    };

    expect(result).toMatchObject({
      status: "failure",
      failureKind: "gate_blocked"
    });
    expect(result.error).toContain("diagnostic self-review");
    expect(provenance.review_authorization).toMatchObject({
      independence_class: "self_review",
      authorized_for_probe: false,
      reason_codes: expect.arrayContaining([
        "review_client_matches_proposer"
      ])
    });
    expect(reviews.every(
      (review) => review.provenance?.independence_class === "self_review"
    )).toBe(true);
    expect(shortlist).toMatchObject({
      probe_candidate_ids: [],
      review_authorization: { authorized_for_probe: false }
    });
  });

  it("writes staged hypothesis artifacts for later inspection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-hypothesis-node-"));
    process.chdir(root);

    const runId = "run-hypothesis-artifacts";
    const run = makeRun(runId);
    const runDir = path.join(root, ".autolabos", "runs", runId);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await writeFile(
      path.join(runDir, "memory", "run_context.json"),
      JSON.stringify({
        version: 1,
        items: [
          {
            key: "run_brief.raw",
            value: [
              "# Research Brief",
              "",
              "## Research Mode",
              "`topic_discovery`",
              "",
              "## Allowed Budgeted Passes",
              '- Machine-readable compute ceiling: `{"bounded_probe":{"max_gpu_hours":2,"max_concurrent_gpus":1,"max_trials":6},"confirmatory":{"max_gpu_hours":8,"max_concurrent_gpus":1,"max_trials":18}}`'
            ].join("\n"),
            updatedAt: new Date().toISOString()
          }
        ]
      }),
      "utf8"
    );
    const evidenceRows = [
      {
        evidence_id: "ev_1",
        paper_id: "paper_1",
        canonical_work_id: "work_paper_1",
        claim: "Structured communication reduces ambiguity.",
        evidence_span: "Structured communication reduces ambiguity, while the comparison omits an independent evaluation partition.",
        limitation_slot: "The comparison omits an independent evaluation partition.",
        limitation_kind: "scientific" as const,
        method_slot: "The prior uses a structured communication intervention.",
        dataset_slot: "evaluation_fixture_a",
        metric_slot: "primary_variance",
        result_slot: "The intervention reduces ambiguity in the reported setting.",
        source_type: "full_text" as const,
        source_scope: "full_text_excerpt" as const,
        grounding_status: "grounded_span" as const,
        confidence: 0.95,
        confidence_reason: "The evidence span is grounded in the source."
      },
      {
        evidence_id: "ev_2",
        paper_id: "paper_2",
        canonical_work_id: "work_paper_2",
        claim: "Execution feedback improves iterative correction.",
        evidence_span: "Execution feedback improves iterative correction, while the comparison omits an independent evaluation partition.",
        limitation_slot: "The comparison omits an independent evaluation partition.",
        limitation_kind: "scientific" as const,
        method_slot: "The prior uses iterative execution feedback.",
        dataset_slot: "evaluation_fixture_b",
        metric_slot: "execution_consistency",
        result_slot: "The intervention improves iterative correction in the reported setting.",
        source_type: "full_text" as const,
        source_scope: "full_text_excerpt" as const,
        grounding_status: "grounded_span" as const,
        confidence: 0.94,
        confidence_reason: "The evidence span is grounded in the source."
      }
    ];
    const evidenceRaw = evidenceRows.map((item) => JSON.stringify(item)).join("\n") + "\n";
    const corpusRaw = [
      JSON.stringify({ paper_id: "paper_1", title: "Paper One" }),
      JSON.stringify({ paper_id: "paper_2", title: "Paper Two" })
    ].join("\n") + "\n";
    const collectAttemptId = "20260102030405678-genericattempt";
    await writeFile(path.join(runDir, "evidence_store.jsonl"), evidenceRaw, "utf8");
    await writeFile(path.join(runDir, "corpus.jsonl"), corpusRaw, "utf8");
    await writeFile(
      path.join(runDir, "collect_generation.json"),
      JSON.stringify({
        version: 1,
        kind: "collect_generation",
        run_id: runId,
        collect_attempt_id: collectAttemptId,
        started_at: new Date().toISOString()
      }),
      "utf8"
    );
    await mkdir(path.join(runDir, "analysis"), { recursive: true });
    const corpusSha256 = createHash("sha256").update(corpusRaw, "utf8").digest("hex");
    const evidenceSha256 = createHash("sha256").update(evidenceRaw, "utf8").digest("hex");
    const gapStatement = "The comparison omits an independent evaluation partition.";
    const gapSynthesis = buildGapSynthesisFixture({
      runId,
      researchCycle: run.graph.researchCycle,
      collectAttemptId,
      corpusSha256,
      evidenceSha256,
      evidence: evidenceRows,
      acceptedClusters: [{
        cluster_id: "gap_cluster_fixture",
        opportunity_type: "explicit_limitation",
        statement: gapStatement,
        evidence_ids: ["ev_1", "ev_2"],
        paper_ids: ["paper_1", "paper_2"]
      }]
    });
    await writeFile(
      path.join(runDir, "analysis", "gap_synthesis.json"),
      JSON.stringify(gapSynthesis, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "analysis", "gap_map.json"),
      JSON.stringify(buildResearchGapMap({
        evidence: evidenceRows,
        semanticClusters: [{
          statement: gapStatement,
          evidence_ids: ["ev_1", "ev_2"],
          opportunity_type: "explicit_limitation"
        }],
        synthesisBinding: {
          content_sha256: gapSynthesis.content_sha256,
          semantics_version: gapSynthesis.semantics_version,
          status: gapSynthesis.status
        },
        analysisCoverage: {
          selected_paper_count: 2,
          completed_paper_count: 2,
          failed_paper_ids: [],
          complete: true
        },
        runId,
        researchCycle: run.graph.researchCycle,
        collectAttemptId,
        corpusSha256,
        corpusByteLength: Buffer.byteLength(corpusRaw, "utf8"),
        evidenceSha256,
        evidenceByteLength: Buffer.byteLength(evidenceRaw, "utf8")
      }), null, 2),
      "utf8"
    );

    const staged = stagedHypothesisClients();
    const llm = staged.proposer;

    const node = createGenerateHypothesesNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      pdfTextLlm: llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    }, staged.reviewDependencies);

    const initialResult = await node.execute({ run, graph: run.graph });
    expect(initialResult).toMatchObject({
      status: "success",
      needsApproval: true,
      transitionRecommendation: {
        action: "backtrack_to_collection",
        targetNode: "collect_papers"
      }
    });
    const candidatePriorPlan = JSON.parse(
      await readFile(
        path.join(runDir, "hypothesis_generation", "candidate_prior_search_plan.json"),
        "utf8"
      )
    ) as CandidatePriorSearchPlan;
    await persistCompletedCandidatePriorSearch({
      runDir,
      corpusRaw,
      collectAttemptId,
      plan: candidatePriorPlan
    });
    const continuedStaged = stagedHypothesisClients();
    const continuedLlm = continuedStaged.proposer;
    const continuedNode = createGenerateHypothesesNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: continuedLlm,
      pdfTextLlm: continuedLlm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    }, continuedStaged.reviewDependencies);
    const result = await continuedNode.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.failureKind).toBe("gate_blocked");
    expect(result.error).toContain("did not authorize an executable topic probe");
    expect(result.toolCallsUsed).toBe(9);

    const hypotheses = await readFile(path.join(runDir, "hypotheses.jsonl"), "utf8");
    const axes = await readFile(path.join(runDir, "hypothesis_generation", "evidence_axes.json"), "utf8");
    const drafts = await readFile(path.join(runDir, "hypothesis_generation", "drafts.jsonl"), "utf8");
    const reviews = await readFile(path.join(runDir, "hypothesis_generation", "reviews.jsonl"), "utf8");
    const llmTrace = await readFile(path.join(runDir, "hypothesis_generation", "llm_trace.json"), "utf8");
    const progress = await readFile(path.join(runDir, "hypothesis_generation", "progress.jsonl"), "utf8");
    const status = await readFile(path.join(runDir, "hypothesis_generation", "status.json"), "utf8");
    const probeShortlist = await readFile(path.join(runDir, "hypothesis_generation", "probe_shortlist.json"), "utf8");
    const hardGateRejections = await readFile(
      path.join(runDir, "hypothesis_generation", "hard_gate_rejections.json"),
      "utf8"
    );
    const topicPortfolio = await readFile(
      path.join(runDir, "hypothesis_generation", "topic_portfolio.json"),
      "utf8"
    );
    const priorAbsorptionMatrix = await readFile(
      path.join(runDir, "hypothesis_generation", "prior_absorption_matrix.json"),
      "utf8"
    );
    const priorAbsorptionMatrixJson = JSON.parse(priorAbsorptionMatrix) as {
      schema_version?: number;
      axis_verification_source?: string;
      candidates?: Array<{
        axis_relation_verification_complete?: boolean;
        comparisons?: Array<{
          axes?: Array<{
            verification_status?: string;
            relation_verification?: {
              provenance?: { context_isolated?: boolean };
            };
          }>;
        }>;
      }>;
    };
    const gapMap = await readFile(path.join(runDir, "analysis", "gap_map.json"), "utf8");
    const gapMapJson = JSON.parse(gapMap) as {
      gaps?: Array<{ gap_id: string; evidence_links: string[] }>;
    };
    const probeShortlistJson = JSON.parse(probeShortlist) as {
      probe_candidate_ids?: string[];
      ranked_candidate_ids?: string[];
      scores?: Array<{ implementation_bonus?: number; bundling_penalty?: number }>;
    };
    const hardGateRejectionsJson = JSON.parse(hardGateRejections) as {
      artifact_kind?: string;
      run_id?: string;
      research_cycle?: number;
      pipeline?: string;
      rejections?: Array<{ candidate_id?: string; reasons?: string[] }>;
    };
    const hypothesisRows = hypotheses.trim().split("\n").map((line) => JSON.parse(line)) as Array<{
      candidate_id?: string;
      metric_unit?: string;
      metric_scale?: string;
      effect_criterion?: { magnitude?: number };
      objective_raw?: string;
    }>;
    const topicPortfolioJson = JSON.parse(topicPortfolio) as {
      run_id?: string;
      research_cycle?: number;
      source_artifacts?: string[];
      source_artifact_bindings?: Array<{ path: string; sha256: string; byte_length: number }>;
      candidate_policy?: { observed?: number };
      candidates?: Array<{
        source_candidate_id?: string;
        review_status?: string;
        probe_status?: string;
        evidence_links?: string[];
        supported_gap_ids?: string[];
        candidate_prior_search?: { selected_direct_prior_ids?: string[] };
      }>;
      probe_allowed?: boolean;
    };
    const statusJson = JSON.parse(status) as { status?: string; stage?: string; probeCandidateCount?: number };

    expect(hypotheses).toContain('"candidate_id":"intervention_1"');
    expect(hypotheses).toContain('"candidate_id":"mechanism_1"');
    expect(hypotheses).toContain('"probe_rank":1');
    expect(hypotheses).toContain('"evidence_snippets"');
    expect(hypotheses).toContain('"paper_titles":["Paper One","Paper Two"]');
    expect(hypothesisRows.every((row) => row.metric_unit === "unitless")).toBe(true);
    expect(hypothesisRows.every((row) => row.metric_scale === "raw")).toBe(true);
    expect(hypothesisRows.every((row) => row.effect_criterion?.magnitude === 0.05)).toBe(true);
    expect(hypothesisRows.every((row) => row.objective_raw?.includes("delta_vs_reference"))).toBe(true);
    expect(axes).toContain('"label": "Structured communication"');
    expect(drafts).toContain('"generator_kind":"mechanism"');
    expect(reviews).toContain('"candidate_id":"intervention_1"');
    expect(llmTrace).toContain('"axes"');
    expect(llmTrace).toContain('"review"');
    expect(llmTrace).toContain('"prompt"');
    expect(llmTrace).toContain('"completion"');
    expect(progress).toContain('"stage":"axes"');
    expect(progress).toContain('"stage":"review"');
    expect(statusJson.status).toBe("failed");
    expect(statusJson.stage).toBe("gating");
    expect(statusJson.probeCandidateCount).toBe(0);
    expect(priorAbsorptionMatrixJson.schema_version).toBe(2);
    expect(priorAbsorptionMatrixJson.axis_verification_source).toBe(
      "explicit_axis_relation_verifier"
    );
    expect(priorAbsorptionMatrixJson.candidates?.every(
      (candidate) =>
        candidate.axis_relation_verification_complete === true
        && candidate.comparisons?.every((comparison) =>
          comparison.axes?.every(
            (axis) =>
              axis.verification_status === "supported"
              && axis.relation_verification?.provenance?.context_isolated === true
          )
        ) === true
    )).toBe(true);
    expect(probeShortlist).toContain('"probe_candidate_ids"');
    expect(probeShortlistJson.scores?.[0]?.implementation_bonus).toBeTypeOf("number");
    expect(probeShortlistJson.scores?.[0]?.bundling_penalty).toBeTypeOf("number");
    expect(hardGateRejectionsJson).toMatchObject({
      artifact_kind: "hypothesis_hard_gate_rejections",
      run_id: runId,
      research_cycle: run.graph.researchCycle,
      pipeline: "staged"
    });
    expect(Array.isArray(hardGateRejectionsJson.rejections)).toBe(true);
    expect(topicPortfolioJson.candidate_policy?.observed).toBe(3);
    expect(topicPortfolioJson.candidates?.map(
      (candidate) => candidate.source_candidate_id
    ).slice(0, probeShortlistJson.ranked_candidate_ids?.length)).toEqual(
      probeShortlistJson.ranked_candidate_ids
    );
    expect(topicPortfolioJson.candidates
      ?.filter((candidate) => candidate.probe_status === "shortlisted")
      .map((candidate) => candidate.source_candidate_id)).toEqual(
      probeShortlistJson.probe_candidate_ids
    );
    expect(topicPortfolioJson.candidates
      ?.filter((candidate) => candidate.probe_status === "shortlisted")
      .every(
        (candidate) =>
          (candidate.candidate_prior_search?.selected_direct_prior_ids?.length ?? 0) > 0
      )).toBe(true);
    expect(topicPortfolioJson.candidates?.some((candidate) => candidate.review_status === "rejected")).toBe(true);
    expect(topicPortfolioJson.candidates?.every((candidate) => {
      const linkedEvidence = new Set(candidate.evidence_links ?? []);
      const expectedGapIds = (gapMapJson.gaps ?? [])
        .filter((gap) => gap.evidence_links.every((evidenceId) => linkedEvidence.has(evidenceId)))
        .map((gap) => gap.gap_id);
      return JSON.stringify(candidate.supported_gap_ids ?? []) === JSON.stringify(expectedGapIds);
    })).toBe(true);
    expect(topicPortfolioJson.run_id).toBe(runId);
    expect(topicPortfolioJson.research_cycle).toBe(run.graph.researchCycle);
    expect(topicPortfolioJson.source_artifacts).toEqual(RESEARCH_FUNNEL_SOURCE_ARTIFACT_PATHS);
    expect(topicPortfolioJson.source_artifact_bindings).toHaveLength(
      RESEARCH_FUNNEL_SOURCE_ARTIFACT_PATHS.length
    );
    expect(
      topicPortfolioJson.source_artifact_bindings?.every(
        (binding) => /^[a-f0-9]{64}$/u.test(binding.sha256) && binding.byte_length >= 0
      )
    ).toBe(true);
    expect(topicPortfolioJson.probe_allowed).toBe(false);
    expect(validateResearchFunnelClosedChain({
      expectedRunId: runId,
      expectedResearchCycle: run.graph.researchCycle,
      gapMapRaw: gapMap,
      evidenceAxesRaw: axes,
      priorAbsorptionMatrixRaw: priorAbsorptionMatrix,
      hypothesesRaw: hypotheses,
      draftsRaw: drafts,
      reviewsRaw: reviews,
      probeShortlistRaw: probeShortlist,
      portfolioRaw: topicPortfolio,
      gapValidationContext: {
        evidence: evidenceRows,
        reviewedClusters: [{
          statement: gapStatement,
          evidence_ids: ["ev_1", "ev_2"],
          opportunity_type: "explicit_limitation"
        }]
      },
      requireDecision: false
    })).toMatchObject({ complete: true, valid: true, reasons: [] });
  });

  it("routes every shortlisted candidate through a bound direct-prior collection plan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-candidate-prior-route-"));
    process.chdir(root);
    const run = makeRun("run-candidate-prior-route");
    const { runDir, corpusRaw, collectAttemptId } =
      await prepareSupportedTopicDiscoveryInputs(run);
    const staged = stagedHypothesisClients();
    const llm = staged.proposer;
    const node = createGenerateHypothesesNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      pdfTextLlm: llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    }, staged.reviewDependencies);

    const result = await node.execute({ run, graph: run.graph });

    expect(result).toMatchObject({
      status: "success",
      needsApproval: true,
      toolCallsUsed: 9,
      transitionRecommendation: {
        action: "backtrack_to_collection",
        sourceNode: "generate_hypotheses",
        targetNode: "collect_papers",
        autoExecutable: true
      }
    });
    const planRaw = await readFile(
      path.join(runDir, "hypothesis_generation", "candidate_prior_search_plan.json"),
      "utf8"
    );
    const plan = JSON.parse(planRaw);
    expect(validateCandidatePriorSearchPlanIntegrity(plan)).toMatchObject({
      valid: true,
      reasons: []
    });
    expect(plan).toMatchObject({
      run_id: run.id,
      research_cycle: run.graph.researchCycle,
      source_corpus: {
        collect_attempt_id: collectAttemptId,
        sha256: createHash("sha256").update(corpusRaw, "utf8").digest("hex"),
        byte_length: Buffer.byteLength(corpusRaw, "utf8")
      }
    });
    expect(plan.candidates).toHaveLength(2);
    expect(
      plan.candidates.every(
        (candidate: { families?: unknown[] }) => candidate.families?.length === 3
      )
    ).toBe(true);
    const decision = JSON.parse(await readFile(
      path.join(runDir, "hypothesis_generation", "candidate_prior_search_decision.json"),
      "utf8"
    ));
    expect(decision).toMatchObject({
      action: "request_collection",
      current_receipt_status: "not_applicable",
      completed_rounds: 0,
      max_rounds: 2
    });
    expect(decision.candidates.filter(
      (candidate: { selected_for_search?: boolean }) => candidate.selected_for_search
    )).toHaveLength(2);
    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    const request = await runContext.get<{
      additional?: number;
      candidatePriorSearchPlan?: { content_sha256?: string };
    }>("collect_papers.request");
    expect(request).toMatchObject({
      additional: 4,
      candidatePriorSearchPlan: { content_sha256: plan.content_sha256 }
    });

    const candidateCollectAttemptId = "20260102040506789-priorsearchresult";
    const sourceArchiveDir = path.join(
      runDir,
      "collect_attempts",
      collectAttemptId
    );
    await mkdir(sourceArchiveDir, { recursive: true });
    await writeFile(path.join(sourceArchiveDir, "corpus.jsonl"), corpusRaw, "utf8");
    const matrix = JSON.parse(await readFile(
      path.join(runDir, "hypothesis_generation", "prior_absorption_matrix.json"),
      "utf8"
    ));
    const drafts = (await readFile(
      path.join(runDir, "hypothesis_generation", "drafts.jsonl"),
      "utf8"
    )).trim().split("\n").map((line) => JSON.parse(line));
    const eligibleCandidateId = plan.candidates[0]?.candidate_id;
    const blockedCandidateId = plan.candidates[1]?.candidate_id;
    if (!eligibleCandidateId || !blockedCandidateId) {
      throw new Error("candidate_prior_admissibility_fixture_incomplete");
    }
    const admissibilityDecision = await prepareCandidatePriorSearchDecision({
      run,
      candidates: drafts,
      matrix,
      shortlistedCandidateIds: [eligibleCandidateId, blockedCandidateId],
      eligibleShortlistedCandidateIds: [eligibleCandidateId],
      collectAttemptId: candidateCollectAttemptId,
      corpusRaw,
      corpusSha256: createHash("sha256").update(corpusRaw, "utf8").digest("hex"),
      corpusByteLength: Buffer.byteLength(corpusRaw, "utf8")
    });
    expect(admissibilityDecision.plan?.candidates.map(
      (candidate) => candidate.candidate_id
    )).toEqual([eligibleCandidateId]);
    expect(admissibilityDecision.artifact.candidates).toContainEqual(
      expect.objectContaining({
        candidate_id: blockedCandidateId,
        probe_eligible: false,
        selected_for_search: false,
        reason_codes: expect.arrayContaining([
          "candidate_prior_search_candidate_not_probe_eligible"
        ])
      })
    );
    const plannedFamilyIds = plan.candidates.flatMap(
      (candidate: { families: Array<{ family_id: string }> }) =>
        candidate.families.map((family) => family.family_id)
    );
    const resultCorpusFor = (selectedPaperId: string): string => {
      const rows = corpusRaw.trim().split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const selectedExists = rows.some(
        (row) => row.paper_id === selectedPaperId
      );
      const boundRows = rows.map((row) =>
        row.paper_id === selectedPaperId
          ? { ...row, query_families: plannedFamilyIds }
          : row
      );
      if (!selectedExists) {
        boundRows.push({
          paper_id: selectedPaperId,
          title: "Selected direct prior",
          query_families: plannedFamilyIds
        });
      }
      return `${boundRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    };
    const receiptFor = (resultCorpusRaw: string, selectedPaperId?: string) =>
      buildCandidatePriorSearchReceipt({
        plan,
        collectAttemptId: candidateCollectAttemptId,
        generatedAt: "2026-01-02T04:05:06.789Z",
        resultCorpusSha256: createHash("sha256")
          .update(resultCorpusRaw, "utf8")
          .digest("hex"),
        resultCorpusByteLength: Buffer.byteLength(resultCorpusRaw, "utf8"),
        attempts: plan.candidates.flatMap((candidate: {
          families: Array<{
            family_id: string;
            query: string;
            lanes: Array<{
              retrieval_lane: "broad_relevance" | "recent_direct_prior";
            }>;
          }>;
        }) => candidate.families.flatMap((family) =>
          family.lanes.map((lane) => {
            const selected = Boolean(
              selectedPaperId && lane.retrieval_lane === "broad_relevance"
            );
            return {
              familyId: family.family_id,
              retrievalLane: lane.retrieval_lane,
              query: family.query,
              fetched: selected ? 1 : 0,
              selected: selected ? 1 : 0,
              selectedPaperIds: selected ? [selectedPaperId] : []
            };
          })
        ))
      });
    await writeFile(
      path.join(runDir, "collect_query_plan.json"),
      JSON.stringify({
        collect_attempt_id: candidateCollectAttemptId,
        strategy: "candidate_prior_portfolio",
        candidate_prior_search_plan: plan
      }),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "collect_candidate_prior_search_plan.json"),
      JSON.stringify(plan),
      "utf8"
    );

    const emptyReceipt = receiptFor(corpusRaw);
    await writeFile(
      path.join(runDir, "collect_candidate_prior_search_receipt.json"),
      JSON.stringify(emptyReceipt),
      "utf8"
    );
    const emptyDecision = await prepareCandidatePriorSearchDecision({
      run,
      candidates: drafts,
      matrix,
      shortlistedCandidateIds: plan.candidates.map(
        (candidate: { candidate_id: string }) => candidate.candidate_id
      ),
      eligibleShortlistedCandidateIds: plan.candidates.map(
        (candidate: { candidate_id: string }) => candidate.candidate_id
      ),
      collectAttemptId: candidateCollectAttemptId,
      corpusRaw,
      corpusSha256: createHash("sha256").update(corpusRaw, "utf8").digest("hex"),
      corpusByteLength: Buffer.byteLength(corpusRaw, "utf8")
    });
    expect(emptyDecision.lineageFailure).toContain(
      "candidate_prior_search_receipt_selected_papers_empty"
    );
    expect(emptyDecision.artifact).toMatchObject({
      action: "blocked_invalid_lineage",
      current_receipt_status: "invalid"
    });

    const omittedCorpusRaw = resultCorpusFor("paper_selected_omitted");
    const omittedReceipt = receiptFor(
      omittedCorpusRaw,
      "paper_selected_omitted"
    );
    await writeFile(
      path.join(runDir, "collect_candidate_prior_search_receipt.json"),
      JSON.stringify(omittedReceipt),
      "utf8"
    );
    const omittedDecision = await prepareCandidatePriorSearchDecision({
      run,
      candidates: drafts,
      matrix,
      shortlistedCandidateIds: plan.candidates.map(
        (candidate: { candidate_id: string }) => candidate.candidate_id
      ),
      eligibleShortlistedCandidateIds: plan.candidates.map(
        (candidate: { candidate_id: string }) => candidate.candidate_id
      ),
      collectAttemptId: candidateCollectAttemptId,
      corpusRaw: omittedCorpusRaw,
      corpusSha256: createHash("sha256").update(omittedCorpusRaw, "utf8").digest("hex"),
      corpusByteLength: Buffer.byteLength(omittedCorpusRaw, "utf8")
    });
    expect(omittedDecision.lineageFailure).toBeUndefined();
    expect(omittedDecision.artifact).toMatchObject({
      action: "already_searched",
      current_receipt_status: "valid",
      candidates: expect.arrayContaining([
        expect.objectContaining({
          covered_by_valid_receipt: true,
          selected_direct_prior_ids: ["paper_selected_omitted"],
          selected_prior_coverage_complete: false,
          probe_eligible: false,
          reason_codes: expect.arrayContaining([
            "candidate_prior_search_selected_prior_absorption_coverage_incomplete"
          ]),
          review_binding: expect.objectContaining({
            plan_content_sha256: plan.content_sha256,
            receipt_content_sha256: omittedReceipt.content_sha256
          })
        })
      ])
    });

    const includedCorpusRaw = resultCorpusFor("paper_1");
    const includedReceipt = receiptFor(includedCorpusRaw, "paper_1");
    await writeFile(
      path.join(runDir, "collect_candidate_prior_search_receipt.json"),
      JSON.stringify(includedReceipt),
      "utf8"
    );
    const includedDecision = await prepareCandidatePriorSearchDecision({
      run,
      candidates: drafts,
      matrix,
      shortlistedCandidateIds: plan.candidates.map(
        (candidate: { candidate_id: string }) => candidate.candidate_id
      ),
      eligibleShortlistedCandidateIds: plan.candidates.map(
        (candidate: { candidate_id: string }) => candidate.candidate_id
      ),
      collectAttemptId: candidateCollectAttemptId,
      corpusRaw: includedCorpusRaw,
      corpusSha256: createHash("sha256").update(includedCorpusRaw, "utf8").digest("hex"),
      corpusByteLength: Buffer.byteLength(includedCorpusRaw, "utf8")
    });
    expect(includedDecision.lineageFailure).toBeUndefined();
    expect(includedDecision.artifact).toMatchObject({
      action: "already_searched",
      current_receipt_status: "valid",
      candidates: expect.arrayContaining([
        expect.objectContaining({
          covered_by_valid_receipt: true,
          selected_direct_prior_ids: ["paper_1"],
          selected_prior_coverage_complete: true,
          probe_eligible: true
        })
      ])
    });
  });

  it("blocks topic discovery before model calls when no gap has independent paper support", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-hypothesis-gap-preflight-"));
    process.chdir(root);

    const runId = "run-hypothesis-gap-preflight";
    const run = makeRun(runId);
    const runDir = path.join(root, ".autolabos", "runs", runId);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    await runContext.put(
      "run_brief.raw",
      [
        "# Research Brief",
        "",
        "## Research Mode",
        "`topic_discovery`",
        "",
        "## Allowed Budgeted Passes",
        '- Machine-readable compute ceiling: `{"bounded_probe":{"max_gpu_hours":2,"max_concurrent_gpus":1,"max_trials":6},"confirmatory":{"max_gpu_hours":8,"max_concurrent_gpus":1,"max_trials":18}}`'
      ].join("\n")
    );
    const evidenceRows = [
      {
        evidence_id: "ev_single",
        paper_id: "paper_single",
        canonical_work_id: "work_paper_single",
        claim: "A bounded evaluation protocol improves consistency.",
        evidence_span: "The protocol improves consistency in a controlled comparison.",
        limitation_slot: "The comparison omits an independent evaluation partition.",
        limitation_kind: "scientific" as const,
        dataset_slot: "evaluation_fixture",
        metric_slot: "primary_variance",
        source_type: "full_text" as const,
        source_scope: "full_text_excerpt" as const,
        grounding_status: "grounded_span" as const,
        confidence: 0.95,
        confidence_reason: "The evidence span is grounded in the source."
      }
    ];
    const evidenceRaw = `${JSON.stringify(evidenceRows[0])}\n`;
    const corpusRaw = `${JSON.stringify({ paper_id: "paper_single", title: "Single Evidence Paper" })}\n`;
    const collectAttemptId = "20260102030405678-gappreflight";
    await writeFile(path.join(runDir, "evidence_store.jsonl"), evidenceRaw, "utf8");
    await writeFile(path.join(runDir, "corpus.jsonl"), corpusRaw, "utf8");
    await writeFile(
      path.join(runDir, "collect_generation.json"),
      JSON.stringify({
        version: 1,
        kind: "collect_generation",
        run_id: runId,
        collect_attempt_id: collectAttemptId,
        started_at: new Date().toISOString()
      }),
      "utf8"
    );
    await mkdir(path.join(runDir, "analysis"), { recursive: true });
    const corpusSha256 = createHash("sha256").update(corpusRaw, "utf8").digest("hex");
    const evidenceSha256 = createHash("sha256").update(evidenceRaw, "utf8").digest("hex");
    const gapSynthesis = buildGapSynthesisFixture({
      runId,
      researchCycle: run.graph.researchCycle,
      collectAttemptId,
      corpusSha256,
      evidenceSha256,
      evidence: evidenceRows,
      acceptedClusters: []
    });
    await writeFile(
      path.join(runDir, "analysis", "gap_synthesis.json"),
      JSON.stringify(gapSynthesis, null, 2),
      "utf8"
    );
    await writeFile(
      path.join(runDir, "analysis", "gap_map.json"),
      JSON.stringify(buildResearchGapMap({
        evidence: evidenceRows,
        semanticClusters: [],
        synthesisBinding: {
          content_sha256: gapSynthesis.content_sha256,
          semantics_version: gapSynthesis.semantics_version,
          status: gapSynthesis.status
        },
        analysisCoverage: {
          selected_paper_count: 1,
          completed_paper_count: 1,
          failed_paper_ids: [],
          complete: true
        },
        runId,
        researchCycle: run.graph.researchCycle,
        collectAttemptId,
        corpusSha256,
        corpusByteLength: Buffer.byteLength(corpusRaw, "utf8"),
        evidenceSha256,
        evidenceByteLength: Buffer.byteLength(evidenceRaw, "utf8")
      }), null, 2),
      "utf8"
    );

    const node = createGenerateHypothesesNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm: new FailIfCalledLLMClient(),
      pdfTextLlm: new FailIfCalledLLMClient(),
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    });
    const result = await node.execute({ run, graph: run.graph });

    expect(result).toMatchObject({ status: "failure", toolCallsUsed: 0 });
    expect(result.error).toContain("research_gap_map_independent_support_missing");
    const status = JSON.parse(
      await readFile(path.join(runDir, "hypothesis_generation", "status.json"), "utf8")
    ) as { status?: string; stage?: string; candidateCount?: number };
    expect(status).toMatchObject({
      status: "failed",
      stage: "research_gap_map",
      candidateCount: 0
    });
    await expect(access(path.join(runDir, "hypotheses.jsonl"))).rejects.toThrow();
  });

  it("persists generate_hypotheses progress artifacts before final completion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-hypothesis-progress-"));
    process.chdir(root);

    const runId = "run-hypothesis-progress";
    const run = makeRun(runId);
    const runDir = path.join(root, ".autolabos", "runs", runId);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await writeFile(path.join(runDir, "memory", "run_context.json"), JSON.stringify({ version: 1, items: [] }), "utf8");
    await writeFile(
      path.join(runDir, "evidence_store.jsonl"),
      [
        JSON.stringify({
          evidence_id: "ev_1",
          paper_id: "paper_1",
          claim: "Structured communication reduces ambiguity.",
          evidence_span: "Structured communication reduces ambiguity by forcing typed handoffs.",
          limitation_slot: "Not isolated against routing alone.",
          dataset_slot: "evaluation_fixture_a",
          metric_slot: "primary_score variance",
          confidence: 0.95
        }),
        JSON.stringify({
          evidence_id: "ev_2",
          paper_id: "paper_2",
          claim: "Execution feedback improves iterative correction.",
          evidence_span: "Execution feedback improves iterative correction through repeated test-repair loops.",
          limitation_slot: "Adds validator cost.",
          dataset_slot: "evaluation_fixture_b",
          metric_slot: "executability",
          confidence: 0.94
        })
      ].join("\n") + "\n",
      "utf8"
    );
    await writeFile(
      path.join(runDir, "corpus.jsonl"),
      [
        JSON.stringify({ paper_id: "paper_1", title: "Paper One" }),
        JSON.stringify({ paper_id: "paper_2", title: "Paper Two" })
      ].join("\n") + "\n",
      "utf8"
    );

    const gate = createDeferred();
    const outputs = stagedHypothesisOutputs();
    const llm = new BlockingQueueJsonLLMClient(
      [...outputs.slice(0, 4), outputs[5] || ""],
      0,
      gate.promise
    );
    const reviewer = new QueueJsonLLMClient([outputs[4] || ""]);
    const node = createGenerateHypothesesNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      pdfTextLlm: llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    }, independentReviewDependencies(reviewer));

    const execution = node.execute({ run, graph: run.graph });
    const statusPath = path.join(runDir, "hypothesis_generation", "status.json");
    const progressPath = path.join(runDir, "hypothesis_generation", "progress.jsonl");
    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));

    const liveStatusText = await waitForText(
      statusPath,
      (text) => text.includes('"status": "running"') && text.includes('"stage": "axes"')
    );
    const liveProgressText = await waitForText(progressPath, (text) => text.includes('"stage":"axes"'));

    expect(liveStatusText).toContain("Synthesizing evidence axes");
    expect(liveProgressText).toContain("Synthesizing evidence axes");
    await expect(runContext.get("generate_hypotheses.progress_stage")).resolves.toBe("axes");
    await expect(runContext.get("generate_hypotheses.status")).resolves.toBe("running");

    gate.resolve();
    const result = await execution;

    expect(result.status).toBe("success");
  });

  it("persists single-pass fallback diagnostics but blocks probes without a completed independent review", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-hypothesis-timeout-"));
    process.chdir(root);
    process.env.AUTOLABOS_HYPOTHESIS_TIMEOUT_MS = "10";

    const runId = "run-hypothesis-timeout";
    const run = makeRun(runId);
    const runDir = path.join(root, ".autolabos", "runs", runId);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await writeFile(path.join(runDir, "memory", "run_context.json"), JSON.stringify({ version: 1, items: [] }), "utf8");
    await writeFile(
      path.join(runDir, "evidence_store.jsonl"),
      [
        JSON.stringify({
          evidence_id: "ev_1",
          paper_id: "paper_1",
          claim: "Structured communication reduces ambiguity.",
          evidence_span: "Structured communication reduces ambiguity by forcing typed handoffs.",
          limitation_slot: "Not isolated against routing alone.",
          dataset_slot: "evaluation_fixture_a",
          metric_slot: "primary_score variance",
          confidence: 0.95
        }),
        JSON.stringify({
          evidence_id: "ev_2",
          paper_id: "paper_2",
          claim: "Execution feedback improves iterative correction.",
          evidence_span: "Execution feedback improves iterative correction through repeated test-repair loops.",
          limitation_slot: "Adds validator cost.",
          dataset_slot: "evaluation_fixture_b",
          metric_slot: "executability",
          confidence: 0.94
        })
      ].join("\n") + "\n",
      "utf8"
    );
    await writeFile(
      path.join(runDir, "corpus.jsonl"),
      [
        JSON.stringify({ paper_id: "paper_1", title: "Paper One" }),
        JSON.stringify({ paper_id: "paper_2", title: "Paper Two" })
      ].join("\n") + "\n",
      "utf8"
    );

    const gate = createDeferred();
    const llm = new BlockingQueueJsonLLMClient(
      [
        JSON.stringify({ summary: "Unreachable staged axes output.", axes: [{ id: "ax_1", label: "unused", mechanism: "unused", intervention: "unused" }] }),
        JSON.stringify({
          summary: "Single-pass fallback shortlisted two bounded probe candidates.",
          candidates: [
            {
              id: "cand_1",
              text: "A disagreement-triggered second pass will improve the primary score under a matched resource budget.",
              novelty: 4,
              feasibility: 5,
              testability: 5,
              cost: 2,
              expected_gain: 4,
              evidence_links: ["ev_1", "ev_2"],
              rationale: "This is directly testable with a matched-budget baseline.",
              ...topicMeasurementContract("fallback_a"),
              measurement_signals: ["primary_score", "uncertainty_interval"],
              measurement_hint: "Compare the primary score with uncertainty under a matched resource budget.",
              boundary_condition: "The effect may vanish when disagreement is a noisy trigger."
            },
            {
              id: "cand_2",
              text: "A correction stage only helps if wrong-to-right edits exceed right-to-wrong damage.",
              novelty: 3,
              feasibility: 5,
              testability: 5,
              cost: 2,
              expected_gain: 3,
              evidence_links: ["ev_2", "ev_1"],
              rationale: "This turns the negative result into a measurable gating hypothesis.",
              ...topicMeasurementContract("fallback_b"),
              measurement_signals: ["primary_score", "secondary_score"],
              measurement_hint: "Track the primary and secondary scores across repeated matched runs.",
              boundary_condition: "The effect reverses when the model is weak at self-critique."
            }
          ],
          probe_candidate_ids: ["cand_1", "cand_2"]
        })
      ],
      0,
      gate.promise
    );

    const eventStream = new InMemoryEventStream();
    const reviewer = new FailIfCalledLLMClient();
    const node = createGenerateHypothesesNode({
      config: {} as any,
      runStore: {} as any,
      eventStream,
      llm,
      pdfTextLlm: llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    }, independentReviewDependencies(reviewer));

    const result = await node.execute({ run, graph: run.graph });
    gate.resolve();

    expect(result.status).toBe("failure");
    expect(result.failureKind).toBe("gate_blocked");
    expect(result.summary).toContain("independent_review_not_completed");
    expect(result.summary).not.toContain("review_client_matches_proposer");

    const status = JSON.parse(await readFile(path.join(runDir, "hypothesis_generation", "status.json"), "utf8")) as {
      status?: string;
      pipeline?: string;
      fallbackReason?: string;
      source?: string;
    };
    const trace = await readFile(path.join(runDir, "hypothesis_generation", "llm_trace.json"), "utf8");
    const progress = await readFile(path.join(runDir, "hypothesis_generation", "progress.jsonl"), "utf8");
    const shortlist = await readFile(path.join(runDir, "hypothesis_generation", "probe_shortlist.json"), "utf8");
    const provenance = await readFile(path.join(runDir, "hypothesis_generation", "review_provenance.json"), "utf8");

    expect(status.status).toBe("failed");
    expect(status.pipeline).toBe("single_pass");
    expect(status.source).toBe("blocked_independent_review");
    expect(status.fallbackReason).toContain("hypothesis_axes_timeout:10ms");
    expect(trace).toContain('"single_pass"');
    expect(progress).toContain("Staged hypothesis pipeline failed, retrying single-pass generation");
    expect(shortlist).toContain('"probe_candidate_ids": []');
    expect(provenance).toContain('"independent_review_not_completed"');
    await expect(access(path.join(runDir, "hypotheses.jsonl"))).rejects.toThrow();
    await expect(access(path.join(runDir, "hypothesis_generation", "topic_portfolio.json"))).rejects.toThrow();
  });

  it("down-weights abstract-only or caveated evidence during hypothesis probe shortlisting", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-hypothesis-evidence-quality-"));
    process.chdir(root);

    const runId = "run-hypothesis-evidence-quality";
    const run = makeRun(runId);
    const runDir = path.join(root, ".autolabos", "runs", runId);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await writeFile(path.join(runDir, "memory", "run_context.json"), JSON.stringify({ version: 1, items: [] }), "utf8");
    await writeFile(
      path.join(runDir, "evidence_store.jsonl"),
      [
        JSON.stringify({
          evidence_id: "ev_1",
          paper_id: "paper_1",
          claim: "Message schemas may reduce ambiguity.",
          evidence_span: "The abstract suggests structured handoffs can help.",
          limitation_slot: "No full-text validation was available.",
          dataset_slot: "evaluation_fixture_a",
          metric_slot: "primary_score variance",
          source_type: "abstract",
          confidence: 0.58,
          confidence_reason: "Only the abstract supports this claim."
        }),
        JSON.stringify({
          evidence_id: "ev_2",
          paper_id: "paper_2",
          claim: "Execution feedback improves reproducibility.",
          evidence_span: "Repeated test-repair loops reduced run-to-run variance in the full paper.",
          limitation_slot: "Adds validator cost.",
          dataset_slot: "evaluation_fixture_b",
          metric_slot: "executability",
          source_type: "full_text",
          confidence: 0.93
        })
      ].join("\n") + "\n",
      "utf8"
    );
    await writeFile(
      path.join(runDir, "corpus.jsonl"),
      [
        JSON.stringify({ paper_id: "paper_1", title: "Paper One" }),
        JSON.stringify({ paper_id: "paper_2", title: "Paper Two" })
      ].join("\n") + "\n",
      "utf8"
    );

    const outputs = [
      JSON.stringify({
        summary: "Mapped evidence into two axes.",
        axes: [
          {
            id: "ax_1",
            label: "Structured messaging",
            mechanism: "Typed handoffs may reduce ambiguity.",
            intervention: "Constrain agent messages to fixed schemas.",
            evaluation_hint: "Measure run-to-run variance.",
            evidence_links: ["ev_1"]
          },
          {
            id: "ax_2",
            label: "Execution feedback",
            mechanism: "Validator-backed correction reduces failure cascades.",
            intervention: "Add bounded execute-test-repair loops.",
            evaluation_hint: "Measure failure-mode stability.",
            evidence_links: ["ev_2"]
          }
        ]
      }),
      JSON.stringify({
        summary: "Generated mechanism drafts.",
        candidates: [
          {
            id: "cand_1",
            text: "Schema-constrained handoffs will reduce run-to-run variance relative to free-form chat.",
            novelty: 5,
            feasibility: 4,
            testability: 5,
            cost: 2,
            expected_gain: 5,
            evidence_links: ["ev_1"],
            axis_ids: ["ax_1"],
            rationale: "The intervention is easy to implement.",
            ...topicMeasurementContract("mechanism")
          }
        ]
      }),
      JSON.stringify({
        summary: "Generated contradiction drafts.",
        candidates: [
          {
            id: "cand_2",
            text: "Schema-constrained handoffs help less when tasks already expose deterministic interfaces.",
            novelty: 3,
            feasibility: 4,
            testability: 4,
            cost: 2,
            expected_gain: 3,
            evidence_links: ["ev_1"],
            axis_ids: ["ax_1"],
            rationale: "The effect likely weakens when ambiguity is already low.",
            ...topicMeasurementContract("contradiction")
          }
        ]
      }),
      JSON.stringify({
        summary: "Generated intervention drafts.",
        candidates: [
          {
            id: "cand_3",
            text: "Bounded execute-test-repair loops will improve reproducibility more than extra peer discussion.",
            novelty: 4,
            feasibility: 4,
            testability: 5,
            cost: 2,
            expected_gain: 5,
            evidence_links: ["ev_2"],
            axis_ids: ["ax_2"],
            rationale: "Execution-grounded correction is directly testable.",
            ...topicMeasurementContract("intervention")
          }
        ]
      }),
      JSON.stringify({
        summary: "Shortlisted the strongest bounded probe drafts.",
        reviews: [
          {
            candidate_id: "mechanism_1",
            keep: true,
            groundedness: 5,
            causal_clarity: 5,
            falsifiability: 5,
            experimentability: 5,
            measurement_specificity: 5,
            measurement_signals: ["run_to_run_variance"],
            measurement_hint: "Measure repeated-run variance across fixed seeds.",
            limitation_reflection: 4,
            measurement_readiness: 5,
            strengths: ["Clear intervention and baseline."],
            weaknesses: ["Evidence is abstract-only."],
            critique_summary: "Good idea but the support is indirect."
          },
          {
            candidate_id: "contradiction_1",
            keep: false,
            groundedness: 3,
            causal_clarity: 3,
            falsifiability: 2,
            experimentability: 2,
            measurement_specificity: 2,
            measurement_signals: [],
            limitation_reflection: 3,
            measurement_readiness: 1,
            strengths: ["Interesting boundary condition."],
            weaknesses: ["Still underspecified."],
            critique_summary: "Too weak."
          },
          {
            candidate_id: "intervention_1",
            keep: true,
            groundedness: 5,
            causal_clarity: 5,
            falsifiability: 5,
            experimentability: 5,
            measurement_specificity: 5,
            measurement_signals: ["failure_mode_stability", "run_to_run_variance"],
            measurement_hint: "Track failure-mode stability and repeated-run variance.",
            limitation_reflection: 4,
            measurement_readiness: 5,
            strengths: ["Directly implementable."],
            weaknesses: ["Adds validator cost."],
            critique_summary: "Best overall evidence support."
          }
        ]
      })
    ];
    const llm = new QueueJsonLLMClient(outputs.slice(0, 4));
    const reviewer = new QueueJsonLLMClient([outputs[4] || ""]);

    const eventStream = new InMemoryEventStream();
    const node = createGenerateHypothesesNode({
      config: {} as any,
      runStore: {} as any,
      eventStream,
      llm,
      pdfTextLlm: llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    }, independentReviewDependencies(reviewer));

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("success");
    const hypotheses = await readFile(path.join(runDir, "hypotheses.jsonl"), "utf8");
    const probeShortlist = await readFile(path.join(runDir, "hypothesis_generation", "probe_shortlist.json"), "utf8");
    const probeShortlistJson = JSON.parse(probeShortlist) as {
      scores?: Array<{
        candidate_id: string;
        evidence_quality_adjustment?: number;
        evidence_quality_notes?: string[];
        final_score?: number;
      }>;
    };

    expect(hypotheses).toContain('"candidate_id":"intervention_1"');
    expect(hypotheses).toContain('"probe_rank":1');
    expect(hypotheses).toContain('"evidence_quality_adjustment"');
    const mechanismScore = probeShortlistJson.scores?.find((item) => item.candidate_id === "mechanism_1");
    const interventionScore = probeShortlistJson.scores?.find((item) => item.candidate_id === "intervention_1");
    expect(mechanismScore?.evidence_quality_adjustment).toBeLessThan(0);
    expect(mechanismScore?.evidence_quality_notes).toContain("abstract_support");
    expect(interventionScore?.evidence_quality_adjustment).toBeGreaterThan(0);
    expect((interventionScore?.final_score ?? 0)).toBeGreaterThan(mechanismScore?.final_score ?? 0);
    const logs = eventStream.history().map((event) => String(event.payload?.text ?? ""));
    expect(logs.some((line) => line.includes("Evidence-quality guardrail"))).toBe(true);
  });

  it("persists partial timeout traces when unreviewed fallback probe authorization is blocked", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-hypothesis-partial-timeout-"));
    process.chdir(root);

    const runId = "run-hypothesis-partial-timeout";
    const run = makeRun(runId);
    const runDir = path.join(root, ".autolabos", "runs", runId);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await writeFile(path.join(runDir, "memory", "run_context.json"), JSON.stringify({ version: 1, items: [] }), "utf8");
    await writeFile(
      path.join(runDir, "evidence_store.jsonl"),
      [JSON.stringify({ evidence_id: "ev_1", paper_id: "paper_1", claim: "Planning matters." })].join("\n") + "\n",
      "utf8"
    );
    await writeFile(path.join(runDir, "corpus.jsonl"), [JSON.stringify({ paper_id: "paper_1", title: "Paper One" })].join("\n") + "\n", "utf8");
    process.env.AUTOLABOS_HYPOTHESIS_TIMEOUT_MS = "10";

    const llm = new QueueProgressThenHangLLMClient([
      '{"summary":"partial axes"',
      '{"summary":"partial single-pass"'
    ]);
    const reviewer = new FailIfCalledLLMClient();

    const node = createGenerateHypothesesNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      pdfTextLlm: llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    }, independentReviewDependencies(reviewer));

    const result = await node.execute({ run, graph: run.graph });

    expect(result.status).toBe("failure");
    expect(result.failureKind).toBe("gate_blocked");
    expect(result.summary).toContain("independent_review_not_completed");
    expect(result.summary).not.toContain("review_client_matches_proposer");
    const llmTrace = await readFile(path.join(runDir, "hypothesis_generation", "llm_trace.json"), "utf8");
    expect(llmTrace).toContain('"axes_partial"');
    expect(llmTrace).toContain('partial axes');
    expect(llmTrace).toContain('"single_pass_partial"');
    expect(llmTrace).toContain('partial single-pass');
  });

  it("blocks an unreviewed single-paper deterministic fallback before experiment design", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-hypothesis-node-gating-"));
    process.chdir(root);

    const runId = "run-hypothesis-gating";
    const run = makeRun(runId);
    const runDir = path.join(root, ".autolabos", "runs", runId);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await writeFile(path.join(runDir, "memory", "run_context.json"), JSON.stringify({ version: 1, items: [] }), "utf8");
    await writeFile(
      path.join(runDir, "evidence_store.jsonl"),
      `${JSON.stringify({
        evidence_id: "ev_1",
        paper_id: "paper_1",
        claim: "In one bounded benchmark, the proposed system beats two discussion references but trails the strongest reference on one partition.",
        dataset_slot: "single_evaluation_fixture",
        metric_slot: "primary_score",
        limitation_slot: "The strongest reference is higher on one partition.",
        source_type: "full_text",
        confidence: 0.35,
        confidence_reason: "Direct table values; the caveat comes from the same table."
      })}
`,
      "utf8"
    );
    await writeFile(
      path.join(runDir, "corpus.jsonl"),
      `${JSON.stringify({ paper_id: "paper_1", title: "A bounded coordination system" })}
`,
      "utf8"
    );

    const llm = new QueueJsonLLMClient(["", "", "", "", ""]);
    const reviewer = new FailIfCalledLLMClient();
    const eventStream = new InMemoryEventStream();
    const node = createGenerateHypothesesNode({
      config: {} as any,
      runStore: {} as any,
      eventStream,
      llm,
      pdfTextLlm: llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    }, independentReviewDependencies(reviewer));

    const result = await node.execute({ run, graph: run.graph });
    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    const statusText = await readFile(path.join(runDir, "hypothesis_generation", "status.json"), "utf8");
    const logText = await readFile(path.join(runDir, "hypothesis_generation", "progress.jsonl"), "utf8");

    expect(result.status).toBe("failure");
    expect(result.failureKind).toBe("gate_blocked");
    expect(result.summary).toContain("independent_review_not_completed");
    expect(result.summary).not.toContain("review_client_matches_proposer");
    await expect(access(path.join(runDir, "hypotheses.jsonl"))).rejects.toThrow();
    await expect(runContext.get("generate_hypotheses.source")).resolves.toBe("blocked_independent_review");
    expect(statusText).toContain("independent_review_not_completed");
    expect(logText).toContain("independent_review_not_completed");
  });

  it("blocks an unreviewed multi-paper deterministic fallback before experiment design", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-hypothesis-node-operational-fallback-gating-"));
    process.chdir(root);

    const runId = "run-hypothesis-operational-fallback-gating";
    const run = makeRun(runId);
    const runDir = path.join(root, ".autolabos", "runs", runId);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await writeFile(path.join(runDir, "memory", "run_context.json"), JSON.stringify({ version: 1, items: [] }), "utf8");
    await writeFile(
      path.join(runDir, "evidence_store.jsonl"),
      [
        JSON.stringify({
          evidence_id: "ev_1",
          paper_id: "paper_1",
          claim: "dataset=Not specified | metric=Not specified | Abstract-only fallback evidence about an unrelated clinical domain.",
          source_type: "abstract",
          confidence: 0.2,
          confidence_reason: "abstract-only fallback evidence; no structured evidence could be grounded"
        }),
        JSON.stringify({
          evidence_id: "ev_2",
          paper_id: "paper_2",
          claim: "dataset=Not specified | metric=Not specified | Abstract-only fallback evidence from a broad survey.",
          source_type: "abstract",
          confidence: 0.2,
          confidence_reason: "abstract-only fallback evidence; no structured evidence could be grounded"
        })
      ].join("\n") + "\n",
      "utf8"
    );
    await writeFile(
      path.join(runDir, "corpus.jsonl"),
      [
        JSON.stringify({ paper_id: "paper_1", title: "Unrelated Clinical Abstract" }),
        JSON.stringify({ paper_id: "paper_2", title: "Unrelated Survey Abstract" })
      ].join("\n") + "\n",
      "utf8"
    );

    const llm = new QueueJsonLLMClient(["", "", "", "", ""]);
    const reviewer = new FailIfCalledLLMClient();
    const eventStream = new InMemoryEventStream();
    const node = createGenerateHypothesesNode({
      config: {} as any,
      runStore: {} as any,
      eventStream,
      llm,
      pdfTextLlm: llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    }, independentReviewDependencies(reviewer));

    const result = await node.execute({ run, graph: run.graph });
    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    const statusText = await readFile(path.join(runDir, "hypothesis_generation", "status.json"), "utf8");
    const logText = await readFile(path.join(runDir, "hypothesis_generation", "progress.jsonl"), "utf8");

    expect(result.status).toBe("failure");
    expect(result.failureKind).toBe("gate_blocked");
    expect(result.summary).toContain("independent_review_not_completed");
    expect(result.summary).not.toContain("review_client_matches_proposer");
    await expect(access(path.join(runDir, "hypotheses.jsonl"))).rejects.toThrow();
    await expect(runContext.get("generate_hypotheses.source")).resolves.toBe("blocked_independent_review");
    expect(statusText).toContain("independent_review_not_completed");
    expect(logText).toContain("independent_review_not_completed");
  });

  it("blocks post-review hypothesis generation before LLM calls when all evidence is weak", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-hypothesis-preflight-gating-"));
    process.chdir(root);

    const runId = "run-hypothesis-preflight-gating";
    const run = makeRun(runId);
    run.graph.transitionHistory.push({
      action: "backtrack_to_hypotheses",
      sourceNode: "review",
      fromNode: "review",
      toNode: "generate_hypotheses",
      reason: "Pre-draft critique classified manuscript as research_memo: claims outpace measured outcome.",
      confidence: 0.8,
      autoExecutable: true,
      appliedAt: new Date().toISOString()
    });
    const runDir = path.join(root, ".autolabos", "runs", runId);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await writeFile(path.join(runDir, "memory", "run_context.json"), JSON.stringify({ version: 1, items: [] }), "utf8");
    await writeFile(
      path.join(runDir, "evidence_store.jsonl"),
      Array.from({ length: 6 }, (_, index) =>
        JSON.stringify({
          evidence_id: `ev_${index + 1}`,
          paper_id: `paper_${index + 1}`,
          claim: "Abstract-only fallback evidence; no structured evidence could be grounded.",
          source_type: "abstract",
          confidence: 0.2,
          confidence_reason: "abstract-only fallback evidence; no structured evidence could be grounded"
        })
      ).join("\n") + "\n",
      "utf8"
    );
    await writeFile(
      path.join(runDir, "corpus.jsonl"),
      Array.from({ length: 6 }, (_, index) =>
        JSON.stringify({ paper_id: `paper_${index + 1}`, title: `Paper ${index + 1}` })
      ).join("\n") + "\n",
      "utf8"
    );

    const llm = new FailIfCalledLLMClient();
    const node = createGenerateHypothesesNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      pdfTextLlm: llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });
    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));
    const statusText = await readFile(path.join(runDir, "hypothesis_generation", "status.json"), "utf8");
    const logText = await readFile(path.join(runDir, "hypothesis_generation", "progress.jsonl"), "utf8");

    expect(result.status).toBe("failure");
    expect(result.summary).toContain("all available evidence items are weak");
    await expect(access(path.join(runDir, "hypotheses.jsonl"))).rejects.toThrow();
    await expect(runContext.get("generate_hypotheses.source")).resolves.toBe("blocked_weak_evidence_preflight");
    expect(statusText).toContain('"stage": "evidence_quality"');
    expect(logText).toContain("all available evidence items are weak");
  });

  it("fails fast when no evidence items are available", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-hypothesis-node-empty-"));
    process.chdir(root);

    const runId = "run-hypothesis-empty";
    const run = makeRun(runId);
    const runDir = path.join(root, ".autolabos", "runs", runId);
    await mkdir(path.join(runDir, "memory"), { recursive: true });
    await writeFile(path.join(runDir, "memory", "run_context.json"), JSON.stringify({ version: 1, items: [] }), "utf8");
    await writeFile(path.join(runDir, "evidence_store.jsonl"), "", "utf8");

    const llm = new QueueJsonLLMClient([]);
    const node = createGenerateHypothesesNode({
      config: {} as any,
      runStore: {} as any,
      eventStream: new InMemoryEventStream(),
      llm,
      pdfTextLlm: llm,
      codex: {} as any,
      aci: {} as any,
      semanticScholar: {} as any,
      responsesPdfAnalysis: {} as any
    });

    const result = await node.execute({ run, graph: run.graph });
    const runContext = new RunContextMemory(path.join(runDir, "memory", "run_context.json"));

    expect(result.status).toBe("failure");
    expect(result.summary).toContain("No evidence is available");
    await expect(access(path.join(runDir, "hypotheses.jsonl"))).rejects.toThrow();
    await expect(runContext.get("generate_hypotheses.top_k")).resolves.toBe(0);
    await expect(runContext.get("generate_hypotheses.candidate_count")).resolves.toBe(0);
    await expect(runContext.get("generate_hypotheses.source")).resolves.toBe("missing_evidence");
  });
});
