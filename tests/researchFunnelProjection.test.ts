import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildActiveTopicProbeContract,
  type ActiveTopicProbeContract
} from "../src/core/activeTopicProbeContract.js";
import {
  RESEARCH_FUNNEL_SOURCE_ARTIFACT_PATHS,
  buildResearchFunnelArtifactBinding,
  buildResearchGapMap,
  buildTopicDecision,
  buildTopicPortfolio,
  hashCanonical,
  resolveSupportedGapIds,
  validateResearchFunnelClosedChain,
  type TopicDecision,
  type TopicPortfolio
} from "../src/core/researchFunnel.js";
import type {
  HypothesisCandidate,
  HypothesisReview
} from "../src/core/analysis/researchPlanning.js";
import { loadResearchFunnelProjection } from "../src/core/runs/researchFunnelProjection.js";
import { buildResearchGapEvidenceChain } from "../src/core/analysis/researchGapEvidenceChain.js";
import {
  RESEARCH_GAP_SYNTHESIS_PROMPT_CONTRACT_VERSION,
  RESEARCH_GAP_SYNTHESIS_SEMANTICS_VERSION
} from "../src/core/analysis/researchGapSynthesis.js";
import { projectResearchFunnel } from "../src/core/runs/jobsProjection.js";
import {
  buildCandidateObjectiveProfileBinding,
  buildCandidateObjectiveRaw
} from "../src/core/effectCriterion.js";
import { buildTopicProbeExecutionBinding } from "../src/core/experimentGovernance.js";
import type { AnalysisReport } from "../src/core/resultAnalysis.js";
import {
  assessEvidenceAdequacy,
  buildEvidenceAdequacyContract,
  buildEvidenceAdequacyExecutionReceipt,
  EVIDENCE_ADEQUACY_ASSESSMENT_RELATIVE_PATH,
  EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH,
  EVIDENCE_ADEQUACY_RECEIPT_RELATIVE_PATH,
  type EvidenceAdequacyAssessmentV2,
  type EvidenceAdequacyContractV2
} from "../src/core/analysis/evidenceAdequacy.js";
import { reassessEvidenceAdequacyArtifacts } from "../src/core/analysis/evidenceAdequacyArtifacts.js";
import { buildTopicProbeOutcomeDecision } from "../src/core/topicProbeOutcome.js";
import { buildTopicProbeFollowupHandoff } from "../src/core/topicProbeFollowup.js";
import { buildTopicProbeReviewGate } from "../src/core/topicProbeReviewGate.js";
import {
  makeTopicProbeComputeBudgetDeclaration,
  makeTopicProbeComputeBudgetLimits
} from "./support/topicProbeComputeBudget.js";
import { makeIndependentHypothesisReviewProvenance } from "./support/hypothesisReviewProvenance.js";
import {
  buildPriorAbsorptionCandidateContract,
  type PriorAbsorptionEvidenceSeed
} from "../src/core/priorAbsorption.js";
import { buildPassingPriorAbsorptionMatrixFixture } from "./support/priorAbsorptionFixture.js";
import {
  buildCandidatePriorSearchPlan,
  buildCandidatePriorSearchReceipt,
  buildCandidatePriorSearchReviewBindings
} from "../src/core/candidatePriorSearch.js";
import {
  buildEstimatorFeasibilityArtifacts,
  ESTIMATOR_FEASIBILITY_CANDIDATE_EXPERIMENT_CONTRACT_RELATIVE_PATH,
  ESTIMATOR_FEASIBILITY_CONTRACT_RELATIVE_PATH,
  ESTIMATOR_FEASIBILITY_REPORT_RELATIVE_PATH
} from "../src/core/estimatorFeasibilityGate.js";
import { buildExperimentContract } from "../src/core/experiments/experimentContract.js";
import type { EstimatorProtocolDeclaration } from "../src/core/estimatorProtocol.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import type { RunRecord } from "../src/types.js";
import { loadTopicProbeExecutionAuthorizationGate } from "../src/core/runs/topicProbeExecutionAuthorizationGate.js";
import {
  appendTopicKillRecord,
  buildTopicFormulationDescriptor,
  buildTopicReentryTicket,
  createTopicMemoryLedger,
  type TopicMemoryLedger,
  type TopicReentryTicket
} from "../src/core/topicMemory.js";
import {
  buildTopicDiscoverySemanticAuditPrompt,
  TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION,
  TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_CALLS,
  TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_FALLBACK_PARTITIONS,
  TOPIC_DISCOVERY_SEMANTIC_TIMEOUT_PARTITION_POLICY
} from "../src/core/collection/topicDiscoverySemanticAudit.js";
import {
  TOPIC_DISCOVERY_CORPUS_QUALITY_STRATEGY,
  TOPIC_DISCOVERY_CORPUS_QUALITY_VERSION
} from "../src/core/collection/topicDiscoveryCorpusQuality.js";
import {
  buildTopicDiscoveryCandidateFamilySignature,
  TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
  TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION
} from "../src/core/topicDiscoveryScientificTerms.js";
import {
  TOPIC_DISCOVERY_CANDIDATE_SIDECAR_VERSION,
  TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT
} from "../src/core/collection/topicDiscoveryArtifactVersions.js";

const GENERATED_AT = "2026-01-01T00:00:00.000Z";
const RUN_ID = "run_projection_fixture";
const RESEARCH_CYCLE = 0;
const createdRoots: string[] = [];
const CANDIDATE_FIXTURE_SCOPES = [
  {
    data: "tabular_partition_fixture",
    contribution: "A structured ranking partition exposes ordering failures."
  },
  {
    data: "temporal_routing_fixture",
    contribution: "A delayed evidence route exposes stale decision failures."
  },
  {
    data: "resource_scheduler_fixture",
    contribution: "A bounded scheduler exposes allocation failures."
  },
  {
    data: "document_alignment_fixture",
    contribution: "A document alignment transfer exposes linkage failures."
  },
  {
    data: "uncertainty_calibration_fixture",
    contribution: "An uncertainty calibration protocol exposes confidence failures."
  }
] as const;

afterEach(async () => {
  await Promise.all(createdRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("loadResearchFunnelProjection", () => {
  it("returns unmeasured without writing when no funnel artifacts exist", async () => {
    const runDir = await createRunDir();

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection).toMatchObject({
      candidateCount: 0,
      probeCandidateCount: 0,
      probeCandidateIds: [],
      probeCandidateStatements: [],
      authorizationDisposition: "unmeasured",
      authorizationProbeAllowed: false,
      topicMemory: {
        status: "unmeasured",
        trusted: false,
        recordCount: 0,
        blockedCandidateCount: 0,
        reentryRequiredCount: 0,
        reentryAllowedCount: 0
      },
      hashes: {},
      artifactRefs: [],
      integrityStatus: "unmeasured"
    });
    expect(projection.reasonCodes).toEqual([
      "research_gap_map_missing",
      "hypothesis_evidence_axes_missing",
      "prior_absorption_matrix_missing",
      "topic_portfolio_missing",
      "topic_decision_missing"
    ]);
    expect(await fs.readdir(runDir)).toEqual([]);
  });

  it("projects a hash-bound candidate direct-prior plan with all intent and lane attempts", async () => {
    const runDir = await createRunDir();
    const item = candidate(
      "candidate_prior_projection",
      ["evidence_methods", "evidence_audit"],
      0,
      false
    );
    const contract = buildPriorAbsorptionCandidateContract(item);
    const sourceCorpusRaw = "{}\n";
    const plan = buildCandidatePriorSearchPlan({
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT,
      asOfDate: GENERATED_AT.slice(0, 10),
      sourceCorpus: {
        collect_attempt_id: "collect_attempt_prior_source",
        sha256: sha256(sourceCorpusRaw),
        byte_length: Buffer.byteLength(sourceCorpusRaw, "utf8")
      },
      candidates: [{ candidate: item, candidateContract: contract }]
    });
    const decisionPayload = {
      schema_version: 1 as const,
      artifact_kind: "candidate_prior_search_decision" as const,
      run_id: RUN_ID,
      research_cycle: RESEARCH_CYCLE,
      generated_at: GENERATED_AT,
      collect_attempt_id: "collect_attempt_prior_source",
      completed_rounds: 0,
      max_rounds: 2,
      current_receipt_status: "not_applicable" as const,
      action: "request_collection" as const,
      candidates: [{
        candidate_id: item.id,
        prior_absorption_contract_sha256: contract.content_sha256,
        reason_codes: ["direct_prior_evidence_requires_refresh"],
        absorbed_by_prior: false,
        covered_by_valid_receipt: false,
        selected_for_search: true
      }],
      plan_content_sha256: plan.content_sha256
    };
    const decision = {
      ...decisionPayload,
      content_sha256: hashCanonical(decisionPayload)
    };
    await Promise.all([
      writeRawArtifact(
        runDir,
        "hypothesis_generation/candidate_prior_search_decision.json",
        JSON.stringify(decision)
      ),
      writeRawArtifact(
        runDir,
        "hypothesis_generation/candidate_prior_search_plan.json",
        JSON.stringify(plan)
      )
    ]);

    const projection = await loadTopicDiscoveryProjection(runDir);
    const apiProjection = projectResearchFunnel(projection);

    expect(projection.candidatePriorSearch).toMatchObject({
      status: "search_required",
      trusted: true,
      action: "request_collection",
      completedRounds: 0,
      maxRounds: 2,
      candidateCount: 1,
      selectedCandidateCount: 1,
      broadLaneAttemptCount: 3,
      recentLaneAttemptCount: 3,
      planHash: plan.content_sha256
    });
    expect(apiProjection.candidate_prior_search).toMatchObject({
      status: "search_required",
      trusted: true,
      broad_lane_attempt_count: 3,
      recent_lane_attempt_count: 3,
      plan_sha256: plan.content_sha256
    });

    const tampered = { ...decision, max_rounds: 3 };
    await writeRawArtifact(
      runDir,
      "hypothesis_generation/candidate_prior_search_decision.json",
      JSON.stringify(tampered)
    );
    const tamperedProjection = await loadTopicDiscoveryProjection(runDir);
    expect(tamperedProjection.candidatePriorSearch).toMatchObject({
      status: "blocked",
      trusted: false
    });
    expect(tamperedProjection.candidatePriorSearch.reasonCodes).toContain(
      "candidate_prior_search_projection_decision_hash_mismatch"
    );

    const foreignPlan = buildCandidatePriorSearchPlan({
      runId: "foreign_run_projection_fixture",
      researchCycle: RESEARCH_CYCLE,
      generatedAt: GENERATED_AT,
      asOfDate: GENERATED_AT.slice(0, 10),
      sourceCorpus: {
        collect_attempt_id: "collect_attempt_prior_source",
        sha256: sha256(sourceCorpusRaw),
        byte_length: Buffer.byteLength(sourceCorpusRaw, "utf8")
      },
      candidates: [{ candidate: item, candidateContract: contract }]
    });
    const reboundDecisionPayload = {
      ...decisionPayload,
      plan_content_sha256: foreignPlan.content_sha256
    };
    const reboundDecision = {
      ...reboundDecisionPayload,
      content_sha256: hashCanonical(reboundDecisionPayload)
    };
    await Promise.all([
      writeRawArtifact(
        runDir,
        "hypothesis_generation/candidate_prior_search_decision.json",
        JSON.stringify(reboundDecision)
      ),
      writeRawArtifact(
        runDir,
        "hypothesis_generation/candidate_prior_search_plan.json",
        JSON.stringify(foreignPlan)
      )
    ]);

    const foreignPlanProjection = await loadTopicDiscoveryProjection(runDir);
    expect(foreignPlanProjection.candidatePriorSearch).toMatchObject({
      status: "blocked",
      trusted: false
    });
    expect(foreignPlanProjection.candidatePriorSearch.reasonCodes).toContain(
      "candidate_prior_search_projection_pending_plan_run_mismatch"
    );
  });

  it("projects a reproducible estimator rejection without promoting execution authority", async () => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture();
    await writeFunnelFixture(runDir, fixture);
    const activeCandidate = fixture.portfolio.candidates[0]!;
    const activeProbe = buildActiveTopicProbeContract({
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE,
      researchMode: "topic_discovery",
      portfolioContentSha256: fixture.portfolio.content_sha256,
      candidate: activeCandidate
    });
    const run = makeProjectionRun();
    const experimentContract = buildProjectionExperimentContract(run);
    const protocol = estimatorProtocolFixture();
    const estimatorArtifacts = buildEstimatorFeasibilityArtifacts({
      runId: RUN_ID,
      activeProbeSha256: activeProbe.content_sha256,
      experimentContract,
      estimatorProtocol: protocol
    });
    expect(estimatorArtifacts.report.status).toBe("blocked");
    await Promise.all([
      writeRawArtifact(
        runDir,
        "design_experiments_panel/active_topic_probe_contract.json",
        JSON.stringify(activeProbe)
      ),
      writeRawArtifact(
        runDir,
        ESTIMATOR_FEASIBILITY_CANDIDATE_EXPERIMENT_CONTRACT_RELATIVE_PATH,
        JSON.stringify(experimentContract)
      ),
      writeRawArtifact(
        runDir,
        ESTIMATOR_FEASIBILITY_CONTRACT_RELATIVE_PATH,
        JSON.stringify(estimatorArtifacts.contract)
      ),
      writeRawArtifact(
        runDir,
        ESTIMATOR_FEASIBILITY_REPORT_RELATIVE_PATH,
        JSON.stringify(estimatorArtifacts.report)
      )
    ]);

    const projection = await loadTopicDiscoveryProjection(runDir);
    const apiProjection = projectResearchFunnel(projection);

    expect(projection.estimatorFeasibility).toMatchObject({
      status: "blocked",
      trusted: true,
      executionAuthorized: false,
      independentClusterCount: 12,
      primaryDenominator: 12
    });
    expect(projection.estimatorFeasibility.reasonCodes).toContain(
      "too_few_clusters"
    );
    expect(apiProjection.estimator_feasibility).toMatchObject({
      status: "blocked",
      trusted: true,
      execution_authorized: false
    });
  });

  it("authorizes execution only for a complete candidate-prior and estimator chain", async () => {
    const researchCycle = 1;
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture({ researchCycle });
    await writeFunnelFixture(runDir, fixture);
    const authorized = await writeAuthorizedExecutionFixture(runDir, fixture);

    const projection = await loadTopicDiscoveryProjection(runDir, { researchCycle });
    const apiProjection = projectResearchFunnel(projection);
    const workspaceRoot = path.dirname(path.dirname(path.dirname(runDir)));
    const gate = await loadTopicProbeExecutionAuthorizationGate({
      workspaceRoot,
      runId: RUN_ID,
      expectedResearchCycle: researchCycle
    });

    expect(projection.candidatePriorSearch).toMatchObject({
      status: "complete",
      trusted: true,
      action: "already_searched",
      currentReceiptStatus: "valid",
      coveredCandidateIds: [authorized.activeProbe.candidate_id]
    });
    expect(projection).toMatchObject({
      collectionState: "quality_gate_passed",
      authorizationTrusted: true,
      authorizationProbeAllowed: true
    });
    expect(projection.estimatorFeasibility).toMatchObject({
      status: "pass",
      trusted: true,
      executionAuthorized: true
    });
    expect(projection.executionAuthorization).toEqual({
      status: "authorized",
      trusted: true,
      authorized: true,
      base_funnel_authorized: true,
      candidate_prior_search_authorized: true,
      estimator_authorized: true,
      required_candidate_ids: [authorized.activeProbe.candidate_id],
      covered_candidate_ids: [authorized.activeProbe.candidate_id],
      reason_codes: []
    });
    expect(projection.effectiveExecutionAuthorized).toBe(true);
    expect(apiProjection).toMatchObject({
      effective_execution_authorized: true,
      execution_authorization: {
        status: "authorized",
        trusted: true,
        authorized: true,
        reason_codes: []
      }
    });
    expect(gate).toMatchObject({
      status: "authorized",
      effective_execution_authorized: true,
      authorization: projection.executionAuthorization
    });
    const { content_sha256: _hash, ...gatePayload } = gate;
    expect(gate.content_sha256).toBe(hashCanonical(gatePayload));
  });

  it("revokes execution authorization when the parent literature archive is tampered", async () => {
    const researchCycle = 1;
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture({ researchCycle });
    await writeFunnelFixture(runDir, fixture);
    const authorized = await writeAuthorizedExecutionFixture(runDir, fixture);
    await writeRawArtifact(
      runDir,
      authorized.parentCorpusRevisionPath,
      `${fixture.raw.corpus}{"tampered":true}\n`
    );

    const projection = await loadTopicDiscoveryProjection(runDir, { researchCycle });

    expect(projection.effectiveExecutionAuthorized).toBe(false);
    expect(projection.executionAuthorization).toMatchObject({
      status: "invalid",
      authorized: false,
      base_funnel_authorized: false
    });
    expect(projection.reasonCodes).toContain(
      "collect_lineage_manifest_immutable_artifact_mismatch"
    );
  });

  it("shows collection success only for current quality semantics with a complete semantic review", async () => {
    const legacyRunDir = await createRunDir();
    const legacyQuality = {
      version: 3,
      research_mode: "topic_discovery",
      strategy: "shared_anchor_axis_proximity_prefilter",
      passed: true,
      reasons: []
    };
    await Promise.all([
      writeRawArtifact(
        legacyRunDir,
        "collect_result.json",
        JSON.stringify({ completed: true, corpusQuality: legacyQuality })
      ),
      writeRawArtifact(
        legacyRunDir,
        "collect_corpus_quality.json",
        JSON.stringify(legacyQuality)
      )
    ]);

    const legacyProjection = await loadTopicDiscoveryProjection(legacyRunDir);

    expect(legacyProjection.collectionState).toBe("quality_gate_failed");
    expect(legacyProjection.reasonCodes).toContain(
      "collect_corpus_quality_semantics_unsupported"
    );

    const currentRunDir = await createRunDir();
    const currentAttemptId = "20260102030405678-currentlineage";
    const currentLineage = buildSemanticLineageFixture(currentAttemptId);
    await Promise.all([
      writeRawArtifact(
        currentRunDir,
        "collect_generation.json",
        JSON.stringify({
          version: 1,
          kind: "collect_generation",
          collect_attempt_id: currentAttemptId
        })
      ),
      writeRawArtifact(
        currentRunDir,
        "collect_result.json",
        JSON.stringify({
          collect_attempt_id: currentAttemptId,
          completed: true,
          corpusQuality: currentLineage.quality
        })
      ),
      writeRawArtifact(
        currentRunDir,
        "collect_corpus_quality.json",
        JSON.stringify(currentLineage.quality)
      ),
      writeRawArtifact(
        currentRunDir,
        "collect_semantic_review_input.json",
        JSON.stringify(currentLineage.semanticInput)
      ),
      writeRawArtifact(
        currentRunDir,
        "collect_semantic_review.json",
        JSON.stringify(currentLineage.semanticReview)
      ),
      writeRawArtifact(
        currentRunDir,
        "collect_topic_discovery_candidates.jsonl",
        currentLineage.candidatesRaw
      )
    ]);

    const currentProjection = await loadTopicDiscoveryProjection(currentRunDir);

    expect(currentProjection.collectionState).toBe("quality_gate_passed");
    expect(currentProjection.reasonCodes).not.toContain(
      "collect_corpus_quality_semantics_unsupported"
    );
  });

  it("trusts authorization only when semantic sidecar lineage is complete", async () => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture();
    await writeFunnelFixture(runDir, fixture);

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection).toMatchObject({
      collectionState: "quality_gate_passed",
      authorizationTrusted: true,
      authorizationProbeAllowed: true
    });
    expect(projection.reasonCodes).not.toContain(
      "collect_semantic_lineage_not_trusted"
    );
  });

  it("revokes authorization when a passed quality artifact lowers its own scientific floor", async () => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture();
    await writeFunnelFixture(runDir, fixture);
    const quality = JSON.parse(fixture.raw.collectQuality) as {
      thresholds: Record<string, number>;
    };
    quality.thresholds.minimum_relevant_papers = 1;
    await writeRawArtifact(
      runDir,
      "collect_corpus_quality.json",
      JSON.stringify(quality)
    );

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection.authorizationTrusted).toBe(false);
    expect(projection.reasonCodes).toContain(
      "collect_semantic_lineage_quality_threshold_mismatch"
    );
  });

  it("revokes authorization for coordinated direct-evidence span fabrication", async () => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture();
    await writeFunnelFixture(runDir, fixture);
    const quality = JSON.parse(fixture.raw.collectQuality) as {
      semantic_judgments: Array<{ evidence_span?: string }>;
    };
    const review = JSON.parse(fixture.raw.collectSemanticReview) as {
      judgments: Array<{ evidence_span?: string }>;
    };
    quality.semantic_judgments[0]!.evidence_span = "fabricated direct evidence span";
    review.judgments[0]!.evidence_span = "fabricated direct evidence span";
    await Promise.all([
      writeRawArtifact(
        runDir,
        "collect_corpus_quality.json",
        JSON.stringify(quality)
      ),
      writeRawArtifact(
        runDir,
        "collect_semantic_review.json",
        JSON.stringify(review)
      )
    ]);

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection.authorizationTrusted).toBe(false);
    expect(projection.reasonCodes).toContain(
      "collect_semantic_lineage_direct_evidence_invalid"
    );
  });

  it("revokes authorization when a retained candidate is hidden from publication", async () => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture();
    await writeFunnelFixture(runDir, fixture);
    const candidates = parseJsonl(fixture.raw.collectCandidates);
    candidates[0]!.published_in_corpus = false;
    await writeRawArtifact(
      runDir,
      "collect_topic_discovery_candidates.jsonl",
      serializeJsonl(candidates)
    );

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection.authorizationTrusted).toBe(false);
    expect(projection.reasonCodes).toContain(
      "collect_semantic_lineage_publication_mismatch"
    );
  });

  it.each([
    {
      name: "duplicate family-local rank",
      mutate(candidates: Array<Record<string, any>>) {
        candidates[0]!.family_retrieval_ranks[0].rank = 2;
      }
    },
    {
      name: "canonical provider outside provenance set",
      mutate(candidates: Array<Record<string, any>>) {
        candidates[0]!.canonical_search_source = "openalex";
      }
    }
  ])("revokes authorization for $name", async ({ mutate }) => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture();
    await writeFunnelFixture(runDir, fixture);
    const candidates = parseJsonl(fixture.raw.collectCandidates);
    mutate(candidates);
    await writeRawArtifact(
      runDir,
      "collect_topic_discovery_candidates.jsonl",
      serializeJsonl(candidates)
    );

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection.authorizationTrusted).toBe(false);
    expect(projection.reasonCodes).toContain(
      "collect_semantic_lineage_candidates_invalid"
    );
  });

  it("revokes authorization for a coordinated overlapping timeout-partition trace", async () => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture();
    await writeFunnelFixture(runDir, fixture);
    const semanticInput = JSON.parse(fixture.raw.collectSemanticInput) as Record<string, any>;
    const review = JSON.parse(fixture.raw.collectSemanticReview) as Record<string, any>;
    const quality = JSON.parse(fixture.raw.collectQuality) as Record<string, any>;
    const tampered = buildTimeoutPartitionExecutionFixture(
      semanticInput.payload,
      [[0, 3], [2, 5], [5, 8]]
    );
    review.execution = tampered.execution;
    review.prompt_sha256 = tampered.promptSha256;
    review.response_sha256 = tampered.responseSha256;
    quality.semantic_review.execution = tampered.execution;
    quality.semantic_review.prompt_sha256 = tampered.promptSha256;
    quality.semantic_review.response_sha256 = tampered.responseSha256;
    await Promise.all([
      writeRawArtifact(
        runDir,
        "collect_semantic_review.json",
        JSON.stringify(review)
      ),
      writeRawArtifact(
        runDir,
        "collect_corpus_quality.json",
        JSON.stringify(quality)
      )
    ]);

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection.authorizationTrusted).toBe(false);
    expect(projection.reasonCodes).toContain(
      "collect_semantic_lineage_execution_mismatch"
    );
  });

  it("revokes authorization when a query plan self-attests generic shared anchors", async () => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture();
    await writeFunnelFixture(runDir, fixture);
    const queryPlan = JSON.parse(fixture.raw.collectQueryPlan) as Record<string, any>;
    for (const family of queryPlan.selected_families) {
      family.topic_discovery_family.sharedAnchorTerms = ["configured", "research"];
    }
    await writeRawArtifact(
      runDir,
      "collect_query_plan.json",
      JSON.stringify(queryPlan)
    );

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection.authorizationTrusted).toBe(false);
    expect(projection.reasonCodes).toContain(
      "collect_semantic_lineage_query_plan_invalid"
    );
  });

  it.each([
    {
      artifact: "collect_semantic_review_input.json",
      reason: "collect_semantic_lineage_input_missing"
    },
    {
      artifact: "collect_semantic_review.json",
      reason: "collect_semantic_lineage_review_missing"
    },
    {
      artifact: "collect_topic_discovery_candidates.jsonl",
      reason: "collect_semantic_lineage_candidates_missing"
    }
  ])("fails closed when $artifact is missing", async ({ artifact, reason }) => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture();
    await writeFunnelFixture(runDir, fixture);
    await fs.rm(path.join(runDir, artifact));

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection).toMatchObject({
      collectionState: "quality_gate_passed",
      authorizationTrusted: false,
      authorizationProbeAllowed: false,
      lifecycleStage: "discovery"
    });
    expect(projection.reasonCodes).toContain(reason);
    expect(projection.reasonCodes).toContain(
      "collect_semantic_lineage_not_trusted"
    );
  });

  it.each([
    {
      name: "input artifact version",
      artifact: "collect_semantic_review_input.json",
      mutate(value: Record<string, any>) {
        value.version = 2;
      },
      reason: "collect_semantic_lineage_input_invalid"
    },
    {
      name: "payload term semantics version",
      artifact: "collect_semantic_review_input.json",
      mutate(value: Record<string, any>) {
        value.payload.term_normalization_version = 99;
      },
      reason: "collect_semantic_lineage_semantics_version_mismatch"
    },
    {
      name: "payload candidate semantics version",
      artifact: "collect_semantic_review_input.json",
      mutate(value: Record<string, any>) {
        value.payload.candidate_recall_semantics_version = 99;
      },
      reason: "collect_semantic_lineage_semantics_version_mismatch"
    },
    {
      name: "payload artifact version",
      artifact: "collect_semantic_review_input.json",
      mutate(value: Record<string, any>) {
        value.payload.version = 2;
      },
      reason: "collect_semantic_lineage_payload_version_mismatch"
    },
    {
      name: "review artifact version",
      artifact: "collect_semantic_review.json",
      mutate(value: Record<string, any>) {
        value.version = 2;
      },
      reason: "collect_semantic_lineage_artifact_version_mismatch"
    },
    {
      name: "review status",
      artifact: "collect_semantic_review.json",
      mutate(value: Record<string, any>) {
        value.status = "partial";
      },
      reason: "collect_semantic_lineage_status_mismatch"
    },
    {
      name: "review input hash",
      artifact: "collect_semantic_review.json",
      mutate(value: Record<string, any>) {
        value.reviewer_input_sha256 = "0".repeat(64);
      },
      reason: "collect_semantic_lineage_input_hash_mismatch"
    },
    {
      name: "review recovery frozen input hash",
      artifact: "collect_semantic_review.json",
      mutate(value: Record<string, any>) {
        value.recovery.frozen_input_sha256 = "0".repeat(64);
      },
      reason: "collect_semantic_lineage_recovery_mismatch"
    },
    {
      name: "reviewed pair universe",
      artifact: "collect_semantic_review.json",
      mutate(value: Record<string, any>) {
        value.judgments[0].family_id = "altered_family";
      },
      reason: "collect_semantic_lineage_pair_universe_mismatch"
    },
    {
      name: "quality semantic count",
      artifact: "collect_corpus_quality.json",
      mutate(value: Record<string, any>) {
        value.semantic_review.counts.reviewed_pairs += 1;
      },
      reason: "collect_semantic_lineage_count_mismatch"
    },
    {
      name: "review recall count",
      artifact: "collect_semantic_review.json",
      mutate(value: Record<string, any>) {
        value.recall.lexical_requested_pairs = 0;
      },
      reason: "collect_semantic_lineage_recall_mismatch"
    },
    {
      name: "quality recall floor",
      artifact: "collect_corpus_quality.json",
      mutate(value: Record<string, any>) {
        value.semantic_review.recall.provider_recall_floor_per_family = 3;
      },
      reason: "collect_semantic_lineage_recall_mismatch"
    }
  ])("fails closed when $name is tampered", async ({ artifact, mutate, reason }) => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture();
    await writeFunnelFixture(runDir, fixture);
    const artifactPath = path.join(runDir, artifact);
    const value = JSON.parse(await fs.readFile(artifactPath, "utf8")) as Record<string, any>;
    mutate(value);
    await writeRawArtifact(runDir, artifact, JSON.stringify(value, null, 2));

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection).toMatchObject({
      collectionState: "quality_gate_passed",
      authorizationTrusted: false,
      authorizationProbeAllowed: false,
      lifecycleStage: "discovery"
    });
    expect(projection.reasonCodes).toContain(reason);
    expect(projection.reasonCodes).toContain(
      "collect_semantic_lineage_not_trusted"
    );
  });

  it("fails closed when the candidate sidecar attempt ID is tampered", async () => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture();
    await writeFunnelFixture(runDir, fixture);
    const candidates = parseJsonl(fixture.raw.collectCandidates);
    candidates[0].collect_attempt_id = "20260102030405678-alteredlineage";
    await writeRawArtifact(
      runDir,
      "collect_topic_discovery_candidates.jsonl",
      serializeJsonl(candidates)
    );

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection).toMatchObject({
      collectionState: "quality_gate_passed",
      authorizationTrusted: false,
      authorizationProbeAllowed: false,
      lifecycleStage: "discovery"
    });
    expect(projection.reasonCodes).toContain(
      "collect_semantic_lineage_attempt_mismatch"
    );
  });

  it("reports mismatch when a gap map is present without its evidence chain", async () => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture();
    await writeRawArtifact(runDir, "analysis/gap_map.json", fixture.raw.gapMap);

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection.integrityStatus).toBe("mismatch");
    expect(projection.hashes).toEqual({ gapMap: undefined });
    expect(projection.reasonCodes).toContain("research_gap_synthesis_missing_or_invalid");
    expect(projection.reasonCodes).toContain("research_gap_map_external_evidence_missing_or_invalid");
    expect(projection.artifactRefs).toEqual([
      { label: "Research gap map", path: "analysis/gap_map.json" }
    ]);
    expect(projection.reasonCodes).toContain("topic_portfolio_missing");
    expect(projection.reasonCodes).toContain("topic_decision_missing");
  });

  it("does not trust an unbound gap map without its reviewed evidence chain", async () => {
    const runDir = await createRunDir();
    const gapMap = buildResearchGapMap({
      generatedAt: GENERATED_AT,
      evidence: []
    });
    await writeRawArtifact(
      runDir,
      "analysis/gap_map.json",
      JSON.stringify(gapMap, null, 2)
    );

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection).toMatchObject({
      integrityStatus: "mismatch",
      authorizationProbeAllowed: false,
      hashes: { gapMap: undefined }
    });
    expect(projection.reasonCodes).toContain("research_gap_map_reviewed_synthesis_required");
    expect(projection.reasonCodes).toContain("research_gap_map_external_evidence_missing_or_invalid");
  });

  it("projects a complete probe-authorized funnel", async () => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture();
    await writeFunnelFixture(runDir, fixture);
    const probeCandidate = fixture.portfolio.candidates.find(
      (candidate) => candidate.source_candidate_id === fixture.decision.probe_candidate_ids[0]
    );

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection).toMatchObject({
      candidateCount: 5,
      probeCandidateCount: 1,
      probeCandidateIds: fixture.decision.probe_candidate_ids,
      probeCandidateStatements: [probeCandidate?.statement],
      authorizationDisposition: "probe_authorized",
      authorizationProbeAllowed: true,
      topicMemory: {
        status: "verified",
        trusted: true,
        ledgerHash: fixture.portfolio.topic_memory_ledger?.ledger_sha256,
        recordCount: 0,
        blockedCandidateCount: 0,
        reentryRequiredCount: 0,
        reentryAllowedCount: 0
      },
      reasonCodes: [],
      hashes: {
        gapMap: fixture.gapMap.content_sha256,
        topicPortfolio: fixture.portfolio.content_sha256,
        topicDecision: fixture.decision.content_sha256
      },
      integrityStatus: "complete"
    });
    expect(projection.portfolioCandidates).toHaveLength(5);
    expect(
      projection.portfolioCandidates.find(
        (candidate) => candidate.candidateId === probeCandidate?.source_candidate_id
      )
    ).toMatchObject({
      candidateId: probeCandidate?.source_candidate_id,
      topicId: probeCandidate?.topic_id,
      statement: probeCandidate?.statement,
      trusted: true,
      reviewStatus: probeCandidate?.review_status,
      probeStatus: probeCandidate?.probe_status,
      probeEligible: probeCandidate?.probe_eligible,
      scores: probeCandidate?.scores,
      closestPriorPaperIds: probeCandidate?.closest_prior_paper_ids,
      closestPriorFullTextPaperIds: probeCandidate?.closest_prior_full_text_paper_ids,
      closestPriorNonOverlap: probeCandidate?.closest_prior_non_overlap,
      reviewerAbsorptionObjection: probeCandidate?.reviewer_absorption_objection,
      killSignal: probeCandidate?.kill_signal,
      minimumPublishableEvidence: probeCandidate?.minimum_publishable_evidence
    });
    expect(projection.artifactRefs.map((artifact) => artifact.path)).toEqual([
      "analysis/gap_map.json",
      "analysis/gap_synthesis.json",
      "evidence_store.jsonl",
      "corpus.jsonl",
      "collect_generation.json",
      "hypothesis_generation/topic_portfolio.json",
      "design_experiments_panel/topic_decision.json",
      "collect_corpus_quality.json",
      "collect_semantic_review_input.json",
      "collect_semantic_review.json",
      "collect_topic_discovery_candidates.jsonl",
      "collect_query_plan.json"
    ]);
  });

  it("projects only aggregate topic-memory observability from a validated portfolio", async () => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture({ topicMemoryScenario: "mixed" });
    await writeFunnelFixture(runDir, fixture);
    await writeRawArtifact(
      runDir,
      "hypothesis_generation/topic_memory_audit.json",
      JSON.stringify({ artifact_kind: "topic_memory_audit" })
    );
    await writeRawArtifact(
      runDir,
      "analysis/topic_memory_update.json",
      JSON.stringify({ artifact_kind: "topic_memory_update" })
    );

    const projection = await loadTopicDiscoveryProjection(runDir);
    const apiProjection = projectResearchFunnel(projection);
    const topicMemoryDecisions = fixture.portfolio.candidates.map(
      (candidate) => candidate.topic_memory!.decision
    );
    const blockedCandidateCount = topicMemoryDecisions.filter(
      (decision) => decision.blocked
    ).length;
    const reentryRequiredCount = topicMemoryDecisions.filter(
      (decision) => decision.disposition === "requires_reentry_adjudication"
    ).length;
    const reentryAllowedCount = topicMemoryDecisions.filter(
      (decision) => decision.disposition === "reentry_allowed"
    ).length;

    expect(projection.topicMemory).toEqual({
      status: "verified",
      trusted: true,
      ledgerHash: fixture.portfolio.topic_memory_ledger?.ledger_sha256,
      recordCount: 3,
      blockedCandidateCount,
      reentryRequiredCount,
      reentryAllowedCount,
      auditArtifactRef: {
        label: "Topic memory audit",
        path: "hypothesis_generation/topic_memory_audit.json"
      },
      updateArtifactRef: {
        label: "Topic memory update",
        path: "analysis/topic_memory_update.json"
      }
    });
    expect(apiProjection.topic_memory).toMatchObject({
      status: "verified",
      trusted: true,
      ledger_sha256: fixture.portfolio.topic_memory_ledger?.ledger_sha256,
      record_count: 3,
      blocked_candidate_count: blockedCandidateCount,
      reentry_required_count: reentryRequiredCount,
      reentry_allowed_count: reentryAllowedCount
    });
    expect(apiProjection.topic_memory).not.toHaveProperty("records");
    expect(apiProjection.topic_memory).not.toHaveProperty("descriptor");
    expect(projection.artifactRefs).toContainEqual({
      label: "Topic memory audit",
      path: "hypothesis_generation/topic_memory_audit.json"
    });
    expect(projection.artifactRefs).toContainEqual({
      label: "Topic memory update",
      path: "analysis/topic_memory_update.json"
    });
  });

  it("projects a validated active topic-probe contract", async () => {
    const runDir = await createRunDir();
    const researchCycle = 1;
    const fixture = buildFunnelFixture({ researchCycle });
    await writeFunnelFixture(runDir, fixture);
    const activeCandidate = fixture.portfolio.candidates.find(
      (candidate) => candidate.source_candidate_id === fixture.decision.probe_candidate_ids[0]
    )!;
    const activeContract = buildActiveTopicProbeContract({
      runId: RUN_ID,
      researchCycle,
      researchMode: "topic_discovery",
      portfolioContentSha256: fixture.portfolio.content_sha256,
      candidate: activeCandidate,
      generatedAt: GENERATED_AT
    });
    await writeRawArtifact(
      runDir,
      "design_experiments_panel/active_topic_probe_contract.json",
      JSON.stringify(activeContract, null, 2)
    );

    const projection = await loadTopicDiscoveryProjection(runDir, { researchCycle });

    expect(projection).toMatchObject({
      activeCandidateId: activeContract.candidate_id,
      activeTopicId: activeContract.topic_id,
      activePrimaryMetric: "primary_score",
      activeMetricDirection: "maximize",
      activeMeaningfulEffect: "At least 0.05 over the declared comparator.",
      activeEvidenceStage: "bounded_probe",
      authorizationProbeAllowed: true,
      integrityStatus: "complete",
      hashes: {
        gapMap: fixture.gapMap.content_sha256,
        topicPortfolio: fixture.portfolio.content_sha256,
        topicDecision: fixture.decision.content_sha256,
        activeTopicProbeContract: activeContract.content_sha256
      }
    });
    expect(projection.artifactRefs).toContainEqual({
      label: "Active topic probe contract",
      path: "design_experiments_panel/active_topic_probe_contract.json"
    });
  });

  it("projects a structured active contract without optional meaningful-effect prose", async () => {
    const runDir = await createRunDir();
    const researchCycle = 1;
    const fixture = buildFunnelFixture({
      researchCycle,
      omitMeaningfulEffect: true,
      probeCandidateCount: 2
    });
    await writeFunnelFixture(runDir, fixture);
    const activeCandidate = fixture.portfolio.candidates.find(
      (candidate) => candidate.source_candidate_id === fixture.decision.probe_candidate_ids[0]
    )!;
    const activeContract = buildActiveTopicProbeContract({
      runId: RUN_ID,
      researchCycle,
      researchMode: "topic_discovery",
      portfolioContentSha256: fixture.portfolio.content_sha256,
      candidate: activeCandidate,
      deferredCandidateIds: fixture.portfolio.probe_candidate_ids.slice(1),
      generatedAt: GENERATED_AT
    });
    await writeRawArtifact(
      runDir,
      "design_experiments_panel/active_topic_probe_contract.json",
      JSON.stringify(activeContract, null, 2)
    );

    const projection = await loadTopicDiscoveryProjection(runDir, { researchCycle });

    expect(projection).toMatchObject({
      activeCandidateId: activeContract.candidate_id,
      activeCandidateHash: activeContract.candidate_content_sha256,
      activeMetricUnit: "proportion",
      activeMetricScale: "proportion",
      activeEffectCriterion: {
        basis: "delta_vs_reference",
        magnitude: 0.05,
        scale: "proportion",
        inclusive: true
      },
      activeObjectiveRaw: activeContract.objective_raw,
      activeDeferredCandidateIds: activeContract.deferred_candidate_ids,
      authorizationTrusted: true,
      authorizationProbeAllowed: true
    });
    expect(projection.activeMeaningfulEffect).toBeUndefined();
  });

  it("projects a report-bound post-probe outcome above authorization state", async () => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture({ researchCycle: RESEARCH_CYCLE });
    await writeFunnelFixture(runDir, fixture);
    const postProbe = await buildPostProbeFixture(runDir, fixture, RESEARCH_CYCLE);
    await writePostProbeArtifacts(runDir, postProbe, "outcome");

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection).toMatchObject({
      lifecycleStage: "outcome_decided",
      boundedProbePaperEvidenceAllowed: false,
      authorizationDisposition: "probe_authorized",
      authorizationProbeAllowed: true,
      outcomeDisposition: "promote_to_confirmatory",
      outcomeNextAction: "start_confirmatory_run",
      outcomeGate: {
        status: "decided",
        trusted: true,
        reasonCodes: ["confirmatory_gate_satisfied"],
        contentHash: postProbe.outcomeGate.content_sha256,
        artifactRef: {
          path: "analysis/topic_probe_outcome_gate.json"
        }
      },
      followupHandoff: { status: "unmeasured", trusted: false },
      reviewGate: {
        status: "unmeasured",
        trusted: false,
        paperDraftingAllowed: false
      },
      invalidChainBlockers: [],
      integrityStatus: "complete"
    });
    expect(projection.hashes).toMatchObject({
      topicProbeOutcome: postProbe.outcome.content_sha256,
      topicProbeOutcomeGate: postProbe.outcomeGate.content_sha256
    });
    expect(projection.lifecycleStage).not.toBe("probe_authorized");
  });

  it("projects a verified follow-up handoff and review gate at the reviewed stage", async () => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture({ researchCycle: RESEARCH_CYCLE });
    await writeFunnelFixture(runDir, fixture);
    const postProbe = await buildPostProbeFixture(runDir, fixture, RESEARCH_CYCLE);
    await writePostProbeArtifacts(runDir, postProbe, "review");

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection).toMatchObject({
      lifecycleStage: "reviewed",
      boundedProbePaperEvidenceAllowed: false,
      authorizationDisposition: "probe_authorized",
      outcomeDisposition: "promote_to_confirmatory",
      outcomeNextAction: "start_confirmatory_run",
      followupHandoff: {
        status: "ready",
        trusted: true,
        recommendedFollowupMode: "hypothesis_test",
        evidenceStage: "confirmatory",
        contentHash: postProbe.handoff.content_sha256,
        artifactRef: {
          path: "review/topic_probe_followup_handoff.json"
        }
      },
      reviewGate: {
        status: "followup_required",
        trusted: true,
        paperDraftingAllowed: false,
        contentHash: postProbe.reviewGate.content_sha256,
        artifactRef: {
          path: "review/topic_probe_gate.json"
        }
      },
      invalidChainBlockers: [],
      integrityStatus: "complete"
    });
  });

  it("prioritizes an unverifiable post-probe artifact as an invalid chain", async () => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture({ researchCycle: RESEARCH_CYCLE });
    await writeFunnelFixture(runDir, fixture);
    const postProbe = await buildPostProbeFixture(runDir, fixture, RESEARCH_CYCLE);
    await writePostProbeArtifacts(runDir, postProbe, "review");
    await writeRawArtifact(
      runDir,
      "analysis/topic_probe_outcome_gate.json",
      JSON.stringify({
        ...postProbe.outcomeGate,
        disposition: "repeat_probe"
      }, null, 2)
    );

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection).toMatchObject({
      lifecycleStage: "invalid_chain",
      boundedProbePaperEvidenceAllowed: false,
      authorizationDisposition: "probe_authorized",
      outcomeDisposition: "promote_to_confirmatory",
      outcomeGate: {
        status: "decided",
        trusted: false
      },
      integrityStatus: "mismatch"
    });
    expect(projection.invalidChainBlockers).toEqual(expect.arrayContaining([
      "topic_probe_outcome_gate_content_hash_mismatch",
      "topic_probe_outcome_gate_disposition_mismatch"
    ]));
    expect(projection.lifecycleStage).not.toBe("reviewed");
    expect(projection.lifecycleStage).not.toBe("probe_authorized");
  });

  it("preserves persisted query fallback and reviewer dissent as diagnostics", async () => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture();
    await writeFunnelFixture(runDir, fixture);
    await writeRawArtifact(
      runDir,
      "collect_result.json",
      JSON.stringify({
        queryAttempts: [{
          query: "controlled evaluation reliability",
          reason: "brief_topic",
          source: "deterministic_query",
          sourceReason: "planner_timeout_fallback",
          filtersRelaxed: false,
          allocatedLimit: 20,
          fetched: 12
        }],
        fallbackAttempts: 1,
        fallbackSources: ["deterministic_query"]
      }, null, 2)
    );
    await writeRawArtifact(
      runDir,
      "design_experiments_panel/reviews.json",
      JSON.stringify([{
        reviewer_id: "statistical_reviewer",
        reviewer_label: "Statistical reviewer",
        candidate_id: "candidate_plan",
        hard_block: true,
        summary: "The comparison lacks a prespecified uncertainty check.",
        findings: ["Add an uncertainty-aware decision rule."]
      }], null, 2)
    );

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection.queryFallbackUsed).toBe(true);
    expect(projection.queryFallbackReasons).toContain("planner_timeout_fallback");
    expect(projection.literatureQueries[0]).toMatchObject({
      source: "deterministic_query",
      sourceReason: "planner_timeout_fallback",
      fallback: true,
      fetched: 12
    });
    expect(projection.dissent).toContainEqual(expect.objectContaining({
      source: "design_panel",
      candidateId: "candidate_plan",
      hardBlock: true,
      reviewerId: "statistical_reviewer",
      trusted: true
    }));
  });

  it("restores an exhausted collection gate and query-only reformulation hints from files", async () => {
    const runDir = await createRunDir();
    const qualityReasons = [
      "Only 1 topic-relevant record was retained; 8 required.",
      "Only 1 independent query family met the coverage floor; 2 required."
    ];
    await Promise.all([
      writeRawArtifact(
        runDir,
        "brief/source_brief.md",
        [
          "# Research Brief",
          "",
          "## Research Mode",
          "topic discovery",
          "",
          "## Topic",
          "Reliable document retrieval evaluation under bounded resources."
        ].join("\n")
      ),
      writeRawArtifact(
        runDir,
        "run_record.json",
        JSON.stringify({
          id: RUN_ID,
          status: "failed",
          graph: {
            researchCycle: RESEARCH_CYCLE,
            retryCounters: { collect_papers: 3 },
            retryPolicy: { maxAttemptsPerNode: 3 },
            nodeStates: { collect_papers: { status: "failed" } }
          },
          usage: {
            byNode: { collect_papers: { executions: 3 } }
          }
        }, null, 2)
      ),
      writeRawArtifact(
        runDir,
        "collect_result.json",
        JSON.stringify({
          completed: false,
          fetchError: "The topic-discovery corpus quality gate rejected the retained records.",
          queryAttempts: [],
          corpusQuality: {
            passed: false,
            reasons: qualityReasons
          }
        }, null, 2)
      ),
      writeRawArtifact(
        runDir,
        "collect_corpus_quality.json",
        JSON.stringify({
          version: 3,
          research_mode: "topic_discovery",
          strategy: "shared_anchor_axis_proximity_prefilter",
          generated_at: GENERATED_AT,
          passed: false,
          reasons: qualityReasons,
          thresholds: {},
          observed: {
            shared_anchor_terms: ["document", "retrieval", "evaluation"]
          },
          query_families: [],
          retained_paper_ids: [],
          excluded_paper_ids: []
        }, null, 2)
      ),
      writeRawArtifact(
        runDir,
        "collect_query_plan.json",
        JSON.stringify({
          version: 2,
          research_mode: "topic_discovery",
          strategy: "topic_portfolio",
          planner: {
            source: "llm",
            attempt_diagnostics: [
              { attempt: 1, status: "rejected_structure" },
              { attempt: 2, status: "accepted" }
            ]
          }
        }, null, 2)
      ),
      writeRawArtifact(
        runDir,
        "collect_query_reformulation_hints.json",
        JSON.stringify({
          version: 2,
          strategy: "anchor_proximate_title_pseudo_relevance_feedback",
          evidence_status: "query_hint_only",
          paper_evidence_allowed: false,
          active: true,
          failure_class: "query_quality_failure",
          feedback_applied: true,
          semantic_review_status: "complete",
          shared_anchor_terms: ["document", "retrieval", "evaluation"],
          candidate_titles: [
            "Confidence intervals for document retrieval evaluation",
            "Sampling-frame diagnostics for document retrieval evaluation"
          ],
          rejected_query_families: [
            {
              query_family: "uncertainty_family",
              query: "document retrieval evaluation confidence interval",
              axis_terms: ["confidence", "interval"],
              relevant_paper_count: 1
            },
            {
              query_family: "sampling_family",
              query: "document retrieval evaluation sampling frame",
              axis_terms: ["sampling", "frame"],
              relevant_paper_count: 0
            }
          ]
        }, null, 2)
      )
    ]);

    const initial = await loadTopicDiscoveryProjection(runDir);
    const restored = await loadResearchFunnelProjection(runDir);

    expect(initial).toMatchObject({
      lifecycleStage: "discovery",
      boundedProbePaperEvidenceAllowed: false,
      collectionState: "quality_gate_exhausted",
      collectionNodeAttempt: 3,
      collectionNodeMaxAttempts: 3,
      queryPlanAttempt: 2,
      collectionQualityFailureReasons: qualityReasons,
      collectionReformulationHint: {
        evidenceStatus: "query_hint_only",
        paperEvidenceAllowed: false,
        active: true,
        failureClass: "query_quality_failure",
        feedbackApplied: true,
        semanticReviewStatus: "complete",
        sharedAnchorTerms: ["document", "retrieval", "evaluation"],
        candidateTitles: expect.arrayContaining([
          "Confidence intervals for document retrieval evaluation"
        ]),
        axes: expect.arrayContaining([
          expect.objectContaining({
            queryFamily: "uncertainty_family",
            axisTerms: ["confidence", "interval"]
          })
        ]),
        artifactRef: {
          path: "collect_query_reformulation_hints.json"
        }
      }
    });
    expect(initial.reasonCodes).toContain("collect_papers_quality_gate_exhausted");
    expect(restored).toEqual(initial);

    const commonProjection = projectResearchFunnel(restored!);
    expect(commonProjection).toMatchObject({
      collection_state: "quality_gate_exhausted",
      collection_node_attempt: 3,
      collection_node_max_attempts: 3,
      query_plan_attempt: 2,
      collection_quality_failure_reasons: qualityReasons,
      collection_reformulation_hint: {
        evidence_status: "query_hint_only",
        paper_evidence_allowed: false,
        candidate_titles: expect.arrayContaining([
          "Sampling-frame diagnostics for document retrieval evaluation"
        ]),
        axes: expect.arrayContaining([
          expect.objectContaining({ axis_terms: ["sampling", "frame"] })
        ])
      }
    });
  });

  it("projects a running current generation while ignoring stale collection artifacts and cumulative usage", async () => {
    const runDir = await createRunDir();
    const currentAttempt = "20260102030405678-currentcycle";
    const staleAttempt = "20260102030405678-priorcycle";
    await Promise.all([
      writeRawArtifact(
        runDir,
        "brief/source_brief.md",
        "# Research Brief\n\n## Research Mode\ntopic discovery\n\n## Topic\nGeneric evaluation validity"
      ),
      writeRawArtifact(
        runDir,
        "run_record.json",
        JSON.stringify({
          id: RUN_ID,
          status: "running",
          graph: {
            researchCycle: RESEARCH_CYCLE,
            retryCounters: { collect_papers: 1 },
            retryPolicy: { maxAttemptsPerNode: 3 },
            nodeStates: { collect_papers: { status: "running" } }
          },
          usage: {
            byNode: { collect_papers: { executions: 8 } }
          }
        })
      ),
      writeRawArtifact(
        runDir,
        "collect_generation.json",
        JSON.stringify({
          version: 1,
          kind: "collect_generation",
          collect_attempt_id: currentAttempt
        })
      ),
      writeRawArtifact(
        runDir,
        "collect_result.json",
        JSON.stringify({
          collect_attempt_id: staleAttempt,
          completed: false,
          fetchError: "stale quality failure",
          corpusQuality: {
            passed: false,
            reasons: ["Stale quality reason must not be authoritative."]
          }
        })
      ),
      writeRawArtifact(
        runDir,
        "collect_corpus_quality.json",
        JSON.stringify({
          collect_attempt_id: staleAttempt,
          passed: false,
          reasons: ["Stale quality reason must not be authoritative."]
        })
      ),
      writeRawArtifact(
        runDir,
        "collect_query_plan.json",
        JSON.stringify({
          collect_attempt_id: staleAttempt,
          planner: { attempt_diagnostics: [{ attempt: 7, status: "accepted" }] }
        })
      ),
      writeRawArtifact(
        runDir,
        "collect_query_reformulation_hints.json",
        JSON.stringify({
          collect_attempt_id: staleAttempt,
          evidence_status: "query_hint_only",
          active: true,
          failure_class: "query_quality_failure",
          feedback_applied: true,
          semantic_review_status: "complete",
          shared_anchor_terms: ["generic", "evaluation"],
          candidate_titles: ["Stale candidate title"],
          rejected_query_families: []
        })
      )
    ]);

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection).toMatchObject({
      collectionState: "collecting",
      collectionNodeAttempt: 2,
      collectionNodeMaxAttempts: 3,
      collectionQualityFailureReasons: [],
      authorizationTrusted: false,
      authorizationProbeAllowed: false
    });
    expect(projection.queryPlanAttempt).toBeUndefined();
    expect(projection.collectionReformulationHint).toBeUndefined();
    expect(projection.reasonCodes).toContain("collect_artifact_generation_mismatch");
    expect(projection.reasonCodes).not.toContain("Stale quality reason must not be authoritative.");
  });

  it("revokes a stale authorized decision when collection is pre-v4 or incomplete", async () => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture();
    const collectAttemptId = JSON.parse(fixture.raw.collectGeneration).collect_attempt_id;
    await writeFunnelFixture(runDir, fixture);
    await writeRawArtifact(
      runDir,
      "collect_corpus_quality.json",
      JSON.stringify({
        version: 3,
        strategy: "shared_anchor_axis_proximity_prefilter",
        collect_attempt_id: collectAttemptId,
        passed: true,
        reasons: []
      })
    );

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection).toMatchObject({
      integrityStatus: "complete",
      collectionState: "quality_gate_failed",
      authorizationDisposition: "probe_authorized",
      authorizationTrusted: false,
      authorizationProbeAllowed: false,
      lifecycleStage: "discovery"
    });
    expect(projection.reasonCodes).toContain(
      "collect_corpus_quality_semantics_unsupported"
    );
    expect(projection.reasonCodes).toContain(
      "collect_corpus_quality_gate_not_passed:quality_gate_failed"
    );
  });

  it.each([
    {
      failureClass: "query_quality_failure" as const,
      active: true,
      feedbackApplied: true,
      semanticReviewStatus: "complete" as const,
      reason: "Too few direct-support papers passed the query-family floor."
    },
    {
      failureClass: "semantic_review_operational_failure" as const,
      active: false,
      feedbackApplied: false,
      semanticReviewStatus: "operational_failure" as const,
      reason: "Semantic review failed operationally: reviewer unavailable."
    },
    {
      failureClass: "semantic_review_incomplete" as const,
      active: false,
      feedbackApplied: false,
      semanticReviewStatus: "partial" as const,
      reason: "Semantic review was incomplete: pair coverage mismatch."
    }
  ])("preserves $failureClass collection failure metadata", async ({
    failureClass,
    active,
    feedbackApplied,
    semanticReviewStatus,
    reason
  }) => {
    const runDir = await createRunDir();
    const attemptId = `20260102030405678-${failureClass}`;
    await Promise.all([
      writeRawArtifact(
        runDir,
        "brief/source_brief.md",
        "# Research Brief\n\n## Research Mode\ntopic discovery\n\n## Topic\nGeneric evaluation validity"
      ),
      writeRawArtifact(
        runDir,
        "collect_generation.json",
        JSON.stringify({
          version: 1,
          kind: "collect_generation",
          collect_attempt_id: attemptId
        })
      ),
      writeRawArtifact(
        runDir,
        "collect_corpus_quality.json",
        JSON.stringify({
          version: TOPIC_DISCOVERY_CORPUS_QUALITY_VERSION,
          term_normalization_version: 2,
          candidate_recall_semantics_version:
            TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
          strategy: TOPIC_DISCOVERY_CORPUS_QUALITY_STRATEGY,
          collect_attempt_id: attemptId,
          passed: false,
          reasons: [reason],
          semantic_review: { status: semanticReviewStatus }
        })
      ),
      writeRawArtifact(
        runDir,
        "collect_query_reformulation_hints.json",
        JSON.stringify({
          version: 2,
          collect_attempt_id: attemptId,
          evidence_status: "query_hint_only",
          paper_evidence_allowed: false,
          active,
          failure_class: failureClass,
          feedback_applied: feedbackApplied,
          semantic_review_status: semanticReviewStatus,
          shared_anchor_terms: ["generic", "evaluation"],
          candidate_titles: ["Bounded query feedback title"],
          rejected_query_families: [{
            query_family: "validation_family",
            axis_terms: ["held", "out"]
          }]
        })
      )
    ]);

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection.collectionState).toBe("quality_gate_failed");
    expect(projection.collectionReformulationHint).toMatchObject({
      active,
      failureClass,
      feedbackApplied,
      semanticReviewStatus
    });
    expect(projection.reasonCodes).toContain(failureClass);
  });

  it("fails closed when collect artifacts belong to different attempt generations", async () => {
    const runDir = await createRunDir();
    const latestAttempt = "20260102030405678-aaaaaaaaaaaa";
    const staleAttempt = "20260102030405678-bbbbbbbbbbbb";
    await Promise.all([
      writeRawArtifact(
        runDir,
        "brief/source_brief.md",
        "# Research Brief\n\n## Research Mode\ntopic discovery\n\n## Topic\nGeneric evaluation validity"
      ),
      writeRawArtifact(
        runDir,
        "run_record.json",
        JSON.stringify({
          id: RUN_ID,
          status: "failed",
          graph: {
            researchCycle: RESEARCH_CYCLE,
            retryCounters: { collect_papers: 1 },
            retryPolicy: { maxAttemptsPerNode: 3 },
            nodeStates: { collect_papers: { status: "failed" } }
          }
        })
      ),
      writeRawArtifact(
        runDir,
        "collect_generation.json",
        JSON.stringify({
          version: 1,
          kind: "collect_generation",
          collect_attempt_id: latestAttempt
        })
      ),
      writeRawArtifact(
        runDir,
        "collect_result.json",
        JSON.stringify({
          collect_attempt_id: latestAttempt,
          completed: false,
          fetchError: "latest attempt failed",
          corpusQuality: { passed: false, reasons: ["latest quality failure"] }
        })
      ),
      writeRawArtifact(
        runDir,
        "collect_query_plan.json",
        JSON.stringify({
          collect_attempt_id: latestAttempt,
          version: 2,
          planner: { attempt_diagnostics: [{ attempt: 1, status: "accepted" }] }
        })
      ),
      writeRawArtifact(
        runDir,
        "collect_corpus_quality.json",
        JSON.stringify({
          collect_attempt_id: staleAttempt,
          passed: false,
          reasons: ["stale quality failure"]
        })
      ),
      writeRawArtifact(
        runDir,
        "collect_query_reformulation_hints.json",
        JSON.stringify({
          collect_attempt_id: staleAttempt,
          evidence_status: "query_hint_only",
          shared_anchor_terms: ["generic", "evaluation"],
          candidate_titles: ["Stale candidate title"],
          rejected_query_families: []
        })
      )
    ]);

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection).toMatchObject({
      collectionState: "failed",
      collectionQualityFailureReasons: []
    });
    expect(projection?.collectionReformulationHint).toBeUndefined();
    expect(projection?.reasonCodes).toContain("collect_artifact_generation_mismatch");
  });

  it("fails closed when a rehashed active contract no longer matches its portfolio candidate", async () => {
    const runDir = await createRunDir();
    const researchCycle = 1;
    const fixture = buildFunnelFixture({ researchCycle });
    await writeFunnelFixture(runDir, fixture);
    const activeCandidate = fixture.portfolio.candidates.find(
      (candidate) => candidate.source_candidate_id === fixture.decision.probe_candidate_ids[0]
    )!;
    const activeContract = buildActiveTopicProbeContract({
      runId: RUN_ID,
      researchCycle,
      researchMode: "topic_discovery",
      portfolioContentSha256: fixture.portfolio.content_sha256,
      candidate: activeCandidate,
      generatedAt: GENERATED_AT
    });
    const { content_sha256: _contentHash, ...changedPayload } = {
      ...activeContract,
      meaningful_effect: "Any observed change is sufficient."
    };
    const changedContract = {
      ...changedPayload,
      content_sha256: hashCanonical(changedPayload)
    };
    await writeRawArtifact(
      runDir,
      "design_experiments_panel/active_topic_probe_contract.json",
      JSON.stringify(changedContract, null, 2)
    );

    const projection = await loadTopicDiscoveryProjection(runDir, { researchCycle });

    expect(projection.integrityStatus).toBe("mismatch");
    expect(projection.authorizationProbeAllowed).toBe(false);
    expect(projection.reasonCodes).toContain(
      "active_topic_probe_contract_candidate_field_mismatch:meaningful_effect"
    );
    expect(projection.activeCandidateId).toBeUndefined();
    expect(projection.activeMeaningfulEffect).toBeUndefined();
    expect(projection.hashes.activeTopicProbeContract).toBeUndefined();
    expect(projection.artifactRefs).toContainEqual({
      label: "Active topic probe contract",
      path: "design_experiments_panel/active_topic_probe_contract.json"
    });
  });

  it("keeps a policy-blocked disposition separate from complete integrity", async () => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture({ candidateCount: 4 });
    await writeFunnelFixture(runDir, fixture);

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection).toMatchObject({
      candidateCount: 4,
      probeCandidateCount: 1,
      authorizationDisposition: "backtrack_to_hypotheses",
      authorizationProbeAllowed: false,
      integrityStatus: "complete"
    });
    expect(projection.reasonCodes).toContain("candidate_count_in_range");
  });

  it("reports an upstream gap-map binding mismatch", async () => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture({ sourceGapMapSha256: "a".repeat(64) });
    await writeFunnelFixture(runDir, fixture);

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection.integrityStatus).toBe("mismatch");
    expect(projection.authorizationProbeAllowed).toBe(false);
    expect(projection.reasonCodes).toContain("topic_portfolio_gap_map_hash_mismatch");
  });

  it("reports a downstream portfolio binding mismatch", async () => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture();
    fixture.decision = rehashDecision({
      ...fixture.decision,
      portfolio_content_sha256: "b".repeat(64)
    });
    fixture.raw.decision = JSON.stringify(fixture.decision, null, 2);
    await writeFunnelFixture(runDir, fixture);

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection.integrityStatus).toBe("mismatch");
    expect(projection.authorizationProbeAllowed).toBe(false);
    expect(projection.reasonCodes).toContain("topic_decision_portfolio_hash_mismatch");
  });

  it("reports mismatch when an artifact is tampered without updating its self-hash", async () => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture();
    const portfolio = structuredClone(fixture.portfolio);
    portfolio.candidates[0]!.statement = "A modified candidate statement.";
    fixture.raw.portfolio = JSON.stringify(portfolio, null, 2);
    await writeFunnelFixture(runDir, fixture);

    const projection = await loadTopicDiscoveryProjection(runDir);

    expect(projection.integrityStatus).toBe("mismatch");
    expect(projection.authorizationProbeAllowed).toBe(false);
    expect(projection.candidateCount).toBe(5);
    expect(projection.clusterCount).toBe(3);
    expect(projection.topicMemory).toMatchObject({
      status: "blocked",
      trusted: false,
      recordCount: 0,
      blockedCandidateCount: 0,
      reentryRequiredCount: 0,
      reentryAllowedCount: 0
    });
    expect(projection.diagnosticsTrusted).toBe(false);
    expect(projection.authorizationTrusted).toBe(false);
    expect(projection.portfolioCandidates).toHaveLength(5);
    expect(projection.portfolioCandidates.every((candidate) => !candidate.trusted)).toBe(true);
    expect(projection.portfolioCandidates[0]?.statement).toBe("A modified candidate statement.");
    expect(
      projection.gates
        .filter((gate) => gate.scope === "topic_portfolio" || gate.scope === "topic_candidate")
        .every((gate) => !gate.trusted)
    ).toBe(true);
    expect(projection.gates.some((gate) => gate.scope === "gap_map" && gate.trusted)).toBe(true);
    expect(projection.reasonCodes).toContain("topic_portfolio_content_hash_mismatch");
  });

  it("reports missing review coverage and copied-cycle artifacts as mismatches", async () => {
    const runDir = await createRunDir();
    const fixture = buildFunnelFixture();
    const reviews = parseJsonl(fixture.raw.reviews).slice(1);
    fixture.raw.reviews = serializeJsonl(reviews);
    fixture.portfolio = replaceSourceBinding(
      fixture.portfolio,
      "hypothesis_generation/reviews.jsonl",
      fixture.raw.reviews
    );
    fixture.raw.portfolio = JSON.stringify(fixture.portfolio, null, 2);
    await writeFunnelFixture(runDir, fixture);

    const missingReviewProjection = await loadTopicDiscoveryProjection(runDir);
    const copiedCycleProjection = await loadTopicDiscoveryProjection(runDir, {
      runId: RUN_ID,
      researchCycle: RESEARCH_CYCLE + 1
    });

    expect(missingReviewProjection.integrityStatus).toBe("mismatch");
    expect(missingReviewProjection.reasonCodes).toContain("research_funnel_review_missing:candidate_1");
    expect(copiedCycleProjection.integrityStatus).toBe("mismatch");
    expect(copiedCycleProjection.reasonCodes).toContain("research_gap_map_research_cycle_mismatch");
  });
});

interface FunnelFixture {
  gapMap: ReturnType<typeof buildResearchGapMap>;
  portfolio: TopicPortfolio;
  decision: TopicDecision;
  raw: {
    gapMap: string;
    gapSynthesis: string;
    evidence: string;
    corpus: string;
    collectGeneration: string;
    collectQuality: string;
    collectSemanticInput: string;
    collectSemanticReview: string;
    collectCandidates: string;
    collectQueryPlan: string;
    evidenceAxes: string;
    priorAbsorptionMatrix: string;
    hypotheses: string;
    drafts: string;
    reviews: string;
    shortlist: string;
    portfolio: string;
    decision: string;
  };
}

async function buildPostProbeFixture(
  runDir: string,
  fixture: FunnelFixture,
  researchCycle: number
) {
  const activeCandidate = fixture.portfolio.candidates.find(
    (candidate) => candidate.source_candidate_id === fixture.decision.probe_candidate_ids[0]
  )!;
  const contract = buildActiveTopicProbeContract({
    runId: RUN_ID,
    researchCycle,
    researchMode: "topic_discovery",
    portfolioContentSha256: fixture.portfolio.content_sha256,
    candidate: activeCandidate,
    generatedAt: GENERATED_AT
  });
  const executionBinding = buildTopicProbeExecutionBinding({
    candidateId: contract.candidate_id,
    candidateContentSha256: contract.candidate_content_sha256,
    comparator: contract.comparator,
    datasetTaskScope: contract.dataset_task_bench
  });
  const targetIndependentUnits = 2;
  const uncertaintyMethod = "paired_bootstrap";
  const evidenceContract = buildEvidenceAdequacyContract({
    primaryComparisonId: executionBinding.primary_comparison_id,
    designSource: {
      kind: "estimator_protocol",
      contentSha256: hashCanonical({
        fixture_kind: "research_funnel_projection_design",
        primary_comparison_id: executionBinding.primary_comparison_id,
        target_independent_units: targetIndependentUnits,
        uncertainty_method: uncertaintyMethod
      })
    },
    independentUnit: {
      key: "matched_item_id",
      analysisUnit: "matched candidate-reference outcome"
    },
    plannedIndependentCoverage: {
      mode: "sampled",
      targetUniqueUnits: targetIndependentUnits,
      targetDenominatorPerArm: targetIndependentUnits
    },
    requiredContrast: {
      arms: ["candidate", "reference"],
      paired: true,
      requiredCompletePairs: targetIndependentUnits
    },
    uncertaintyRequirement: {
      mode: "required",
      allowedMethods: [uncertaintyMethod],
      confidenceLevel: 0.95,
      decisionRule: "directed_interval_bound_meets_effect_criterion"
    },
    effectResolution: {
      scale: contract.metric_scale,
      minimumResolvableEffect: 0.01
    },
    executionBudget: {
      applicable: false,
      notApplicableRationale: "The projection fixture freezes evidence coverage instead of an execution-cost floor."
    }
  });
  const receipt = buildEvidenceAdequacyExecutionReceipt({
    contractSha256: evidenceContract.content_sha256,
    primaryComparisonId: evidenceContract.primary_comparison_id,
    uniqueExecutionIds: ["execution_1", "execution_2", "execution_3", "execution_4"],
    observedIndependentUnitIds: ["matched_item_1", "matched_item_2"],
    observedDenominatorByArm: { candidate: 2, reference: 2 },
    observedPairCoverage: {
      completePairIds: ["matched_pair_1", "matched_pair_2"],
      incompletePairIds: []
    },
    observedUncertaintyMethods: [uncertaintyMethod],
    primaryEvidenceRefs: [
      "metrics.json#/candidate",
      "metrics.json#/reference",
      "metrics.json#/comparison"
    ]
  });
  const assessment = assessEvidenceAdequacy({
    contract: evidenceContract,
    receipt,
    verifiedEvidenceRefs: receipt.primary_evidence_refs
  });
  await Promise.all([
    writeRawArtifact(runDir, EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH, JSON.stringify(evidenceContract, null, 2)),
    writeRawArtifact(runDir, EVIDENCE_ADEQUACY_RECEIPT_RELATIVE_PATH, JSON.stringify(receipt, null, 2)),
    writeRawArtifact(runDir, EVIDENCE_ADEQUACY_ASSESSMENT_RELATIVE_PATH, JSON.stringify(assessment, null, 2)),
    writeRawArtifact(runDir, "metrics.json", JSON.stringify({
      candidate: { value: 0.56 },
      reference: { value: 0.5 },
      comparison: { delta: 0.06 }
    }, null, 2))
  ]);
  const reassessment = await reassessEvidenceAdequacyArtifacts({
    runDir,
    evidenceRoots: [runDir],
    expectedPrimaryComparisonId: executionBinding.primary_comparison_id,
    requireStoredAssessment: true
  });
  if (!reassessment.authorization || !reassessment.assessment) {
    throw new Error(`projection_evidence_authorization_missing:${reassessment.issues.join("|")}`);
  }
  const report = analysisReport(contract, evidenceContract, reassessment.assessment);
  const outcome = buildTopicProbeOutcomeDecision({
    contract,
    report,
    evidenceAdequacyAuthorization: reassessment.authorization
  });
  const outcomeGatePayload = {
    schema_version: 1 as const,
    artifact_kind: "topic_probe_outcome_gate" as const,
    run_id: RUN_ID,
    research_cycle: researchCycle,
    status: "decided" as const,
    disposition: outcome.disposition,
    outcome_content_sha256: outcome.content_sha256,
    reason_codes: [...outcome.reason_codes]
  };
  const outcomeGate = {
    ...outcomeGatePayload,
    content_sha256: hashCanonical(outcomeGatePayload)
  };
  const handoff = buildTopicProbeFollowupHandoff({
    portfolio: fixture.portfolio,
    contract,
    outcome,
    candidate: activeCandidate
  });
  const reviewGate = buildTopicProbeReviewGate({
    runId: RUN_ID,
    researchCycle,
    outcome,
    handoff
  });
  return { contract, report, outcome, outcomeGate, handoff, reviewGate };
}

async function writePostProbeArtifacts(
  runDir: string,
  fixture: Awaited<ReturnType<typeof buildPostProbeFixture>>,
  through: "outcome" | "review"
): Promise<void> {
  const artifacts: Array<readonly [string, string]> = [
    [
      "design_experiments_panel/active_topic_probe_contract.json",
      JSON.stringify(fixture.contract, null, 2)
    ],
    ["result_analysis.json", JSON.stringify(fixture.report, null, 2)],
    ["analysis/topic_probe_outcome.json", JSON.stringify(fixture.outcome, null, 2)],
    [
      "analysis/topic_probe_outcome_gate.json",
      JSON.stringify(fixture.outcomeGate, null, 2)
    ]
  ];
  if (through === "review") {
    artifacts.push(
      [
        "review/topic_probe_followup_handoff.json",
        JSON.stringify(fixture.handoff, null, 2)
      ],
      ["review/topic_probe_gate.json", JSON.stringify(fixture.reviewGate, null, 2)]
    );
  }
  await Promise.all(
    artifacts.map(([relativePath, raw]) => writeRawArtifact(runDir, relativePath, raw))
  );
}

function buildSemanticLineageFixture(collectAttemptId: string) {
  const sharedAnchorTerms = ["bound", "evaluation"];
  const families = [
    {
      familyId: "uncertainty_family",
      query: '"bounded evaluation" uncertainty sampling',
      source: "llm_query_planner",
      axisTerms: ["uncertainty", "sampling"],
      lens: "measurement reliability",
      contributionIntent: "measurement",
      contractSource: "planner_declared"
    },
    {
      familyId: "robustness_family",
      query: '"bounded evaluation" robustness calibration',
      source: "llm_query_planner",
      axisTerms: ["robustness", "calibration"],
      lens: "robustness under calibrated evidence",
      contributionIntent: "empirical_finding",
      contractSource: "planner_declared"
    }
  ];
  const papers = families.flatMap((family, familyIndex) => {
    const paperIds = familyIndex === 0
      ? ["prior_methods", "prior_audit", "lineage_a3", "lineage_a4"]
      : ["lineage_b1", "lineage_b2", "lineage_b3", "lineage_b4"];
    return paperIds.map((paperId, paperIndex) => ({
      paper_id: paperId,
      title:
        `Bounded evaluation ${family.axisTerms.join(" ")} study ${paperIndex + 1}`,
      abstract:
        `This bounded evaluation study directly examines ${family.axisTerms.join(" and ")}.`,
      query_families: [family.familyId]
    }));
  });
  const requestedPairs = papers.map((paper) => ({
    paper_id: paper.paper_id,
    family_id: paper.query_families[0]!,
    selection_source: "lexical_match" as const
  }));
  const payload = {
    version: TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION,
    term_normalization_version: TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION,
    candidate_recall_semantics_version:
      TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
    papers: papers.map(({ paper_id, title, abstract }) => ({
      paper_id,
      title,
      abstract
    })),
    family_contracts: families.map((family) => ({
      family_id: family.familyId,
      query: family.query,
      axis_terms: family.axisTerms,
      lens: family.lens,
      contribution_intent: family.contributionIntent
    })),
    requested_pairs: requestedPairs
  };
  const reviewerInputSha256 = sha256(JSON.stringify(payload));
  const reviewerInputBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  const promptSha256 = sha256(buildTopicDiscoverySemanticAuditPrompt(payload));
  const responseSha256 = sha256("generic semantic review response");
  const judgments = papers.map((paper) => ({
    paper_id: paper.paper_id,
    family_id: paper.query_families[0]!,
    verdict: "direct_support",
    reason: "The work directly studies the declared family contract.",
    evidence_span: paper.title
  }));
  const counts = {
    requested_pairs: papers.length,
    reviewed_pairs: papers.length,
    budget_excluded_pairs: 0,
    returned_judgments: papers.length,
    direct_support: papers.length,
    application_only: 0,
    uncertain: 0,
    omitted_judgments: 0,
    duplicate_judgments: 0,
    conflicting_judgments: 0,
    invented_judgments: 0,
    malformed_judgments: 0,
    protocol_violations: 0
  };
  const limits = {
    max_pairs: 64,
    max_input_bytes: 131_072,
    abstract_chars: 2_000,
    timeout_ms: 30_000
  };
  const execution = {
    policy: TOPIC_DISCOVERY_SEMANTIC_TIMEOUT_PARTITION_POLICY,
    maximum_calls: TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_CALLS,
    maximum_fallback_partitions:
      TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_FALLBACK_PARTITIONS,
    total_deadline_ms: 120_000,
    fallback_partition_size: Math.ceil(papers.length / 3),
    calls_started: 1,
    calls_completed: 1,
    cumulative_reviewer_input_bytes: reviewerInputBytes,
    calls: [{
      call_index: 1,
      mode: "primary",
      pair_start_index: 0,
      pair_end_index_exclusive: papers.length,
      requested_pair_count: papers.length,
      reviewer_input_sha256: reviewerInputSha256,
      reviewer_input_bytes: reviewerInputBytes,
      prompt_sha256: promptSha256,
      response_sha256: responseSha256,
      outcome: "complete"
    }]
  };
  const semanticReviewSummary = {
    version: TOPIC_DISCOVERY_SEMANTIC_AUDIT_VERSION,
    status: "complete",
    prompt_sha256: promptSha256,
    response_sha256: responseSha256,
    reviewer_input_sha256: reviewerInputSha256,
    reviewer_input_bytes: reviewerInputBytes,
    limits,
    counts,
    recall: {
      provider_recall_floor_per_family: 4,
      lexical_requested_pairs: papers.length,
      provider_provenance_requested_pairs: 0
    },
    execution,
    reasons: [],
    protocol_violations: []
  };
  return {
    quality: {
      version: TOPIC_DISCOVERY_CORPUS_QUALITY_VERSION,
      term_normalization_version: TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION,
      candidate_recall_semantics_version:
        TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION,
      research_mode: "topic_discovery",
      strategy: TOPIC_DISCOVERY_CORPUS_QUALITY_STRATEGY,
      collect_attempt_id: collectAttemptId,
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
        total_papers: papers.length,
        relevant_papers: papers.length,
        relevant_share: 1,
        lexical_relevant_papers: papers.length,
        semantic_requested_papers: papers.length,
        direct_support_papers: papers.length,
        application_only_pairs: 0,
        uncertain_pairs: 0,
        shared_anchor_terms: sharedAnchorTerms,
        required_anchor_matches_per_paper: sharedAnchorTerms.length,
        anchor_proximate_papers: papers.length,
        anchor_axis_proximate_papers: papers.length,
        covered_query_families: families.length
      },
      query_families: families.map((family) => ({
        query_family: family.familyId,
        query: family.query,
        source: family.source,
        positive_terms: family.axisTerms,
        axis_terms: family.axisTerms,
        lens: family.lens,
        contribution_intent: family.contributionIntent,
        contract_source: family.contractSource,
        canonical_family_signature: buildTopicDiscoveryCandidateFamilySignature({
          sharedAnchorTerms,
          axisTerms: family.axisTerms
        }),
        required_axis_matches: 2,
        lexical_relevant_paper_count: 4,
        semantic_reviewed_paper_count: 4,
        provider_recall_paper_count: 0,
        direct_support_paper_count: 4,
        application_only_paper_count: 0,
        uncertain_paper_count: 0,
        semantic_precision: 1,
        retained_paper_count: 4,
        relevant_paper_count: 4
      })),
      semantic_review: semanticReviewSummary,
      semantic_judgments: judgments,
      retained_paper_ids: papers.map((paper) => paper.paper_id),
      excluded_paper_ids: []
    },
    semanticInput: {
      version: 1,
      collect_attempt_id: collectAttemptId,
      evidence_status: "semantic_review_input_only",
      paper_evidence_allowed: false,
      reviewer_identity: "fixture_reviewer",
      payload_sha256: reviewerInputSha256,
      payload
    },
    semanticReview: {
      ...semanticReviewSummary,
      collect_attempt_id: collectAttemptId,
      evidence_status: "semantic_review_judgment_only",
      paper_evidence_allowed: false,
      reviewer_identity: "fixture_reviewer",
      recovery: {
        policy: "frozen_input_single_retry_v1",
        maximum_attempts: 2,
        frozen_input_sha256: reviewerInputSha256,
        input_integrity_verified: true,
        recovery_performed: false,
        exhausted: false,
        attempts: [{
          attempt: 1,
          status: "complete",
          reviewer_input_sha256: reviewerInputSha256,
          prompt_sha256: promptSha256,
          response_sha256: responseSha256,
          calls_started: 1,
          reasons: []
        }]
      },
      judgments
    },
    candidatesRaw: serializeJsonl(papers.map((paper) => ({
      ...paper,
      schema_version: TOPIC_DISCOVERY_CANDIDATE_SIDECAR_VERSION,
      collect_attempt_id: collectAttemptId,
      evidence_status: "semantic_screening_candidate_only",
      paper_evidence_allowed: false,
      retrieval_status: "retrieved_governance_usable",
      family_retrieval_ranks: [{
        family_id: paper.query_families[0],
        rank: papers
          .filter((candidate) =>
            candidate.query_families[0] === paper.query_families[0]
          )
          .findIndex((candidate) => candidate.paper_id === paper.paper_id) + 1
      }],
      canonical_search_source: "semantic_scholar",
      search_providers: ["semantic_scholar"],
      lexical_matched_query_families: paper.query_families,
      semantic_review_selections: [{
        family_id: paper.query_families[0],
        selection_source: "lexical_match"
      }],
      semantic_review_requested_query_families: paper.query_families,
      semantic_review_requested: true,
      selected_by_semantic_quality: true,
      published_in_corpus: true
    }))),
    queryPlan: {
      ...TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT,
      collect_attempt_id: collectAttemptId,
      research_mode: "topic_discovery",
      strategy: "topic_portfolio",
      selected_families: families.map((family) => ({
        query: family.query,
        query_family: family.familyId,
        source: family.source,
        topic_discovery_family: {
          familyId: family.familyId,
          sharedAnchorTerms,
          axisTerms: family.axisTerms,
          lens: family.lens,
          contributionIntent: family.contributionIntent,
          contractSource: family.contractSource
        }
      }))
    },
    corpusRows: papers.map((paper) => ({ ...paper, authors: [] }))
  };
}

function buildTimeoutPartitionExecutionFixture(
  payload: Record<string, any>,
  fallbackRanges: Array<readonly [number, number]>
): {
  execution: Record<string, any>;
  promptSha256: string;
  responseSha256: string;
} {
  const pairCount = payload.requested_pairs.length;
  const callSpecs = [
    { mode: "primary", start: 0, end: pairCount, outcome: "timeout", reason: "semantic_audit_timeout" },
    ...fallbackRanges.map(([start, end]) => ({
      mode: "timeout_partition",
      start,
      end,
      outcome: "complete"
    }))
  ];
  const prompts: string[] = [];
  const responseHashes: string[] = [];
  let cumulativeBytes = 0;
  const calls = callSpecs.map((spec, index) => {
    const callPayload = index === 0
      ? payload
      : projectSemanticPayloadFixture(payload, spec.start, spec.end);
    const serialized = JSON.stringify(callPayload);
    const prompt = buildTopicDiscoverySemanticAuditPrompt(callPayload);
    const responseSha256 = sha256(`semantic response ${index + 1}`);
    prompts.push(prompt);
    responseHashes.push(responseSha256);
    cumulativeBytes += Buffer.byteLength(serialized, "utf8");
    return {
      call_index: index + 1,
      mode: spec.mode,
      pair_start_index: spec.start,
      pair_end_index_exclusive: spec.end,
      requested_pair_count: spec.end - spec.start,
      reviewer_input_sha256: sha256(serialized),
      reviewer_input_bytes: Buffer.byteLength(serialized, "utf8"),
      prompt_sha256: sha256(prompt),
      response_sha256: responseSha256,
      outcome: spec.outcome,
      ...(spec.reason ? { reason: spec.reason } : {})
    };
  });
  return {
    execution: {
      policy: TOPIC_DISCOVERY_SEMANTIC_TIMEOUT_PARTITION_POLICY,
      maximum_calls: TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_CALLS,
      maximum_fallback_partitions:
        TOPIC_DISCOVERY_SEMANTIC_MAXIMUM_FALLBACK_PARTITIONS,
      total_deadline_ms: 120_000,
      fallback_partition_size: Math.ceil(pairCount / 3),
      calls_started: calls.length,
      calls_completed: calls.length - 1,
      cumulative_reviewer_input_bytes: cumulativeBytes,
      calls
    },
    promptSha256: sha256(prompts.join("\n--- semantic-review-call ---\n")),
    responseSha256: sha256(JSON.stringify(responseHashes))
  };
}

function projectSemanticPayloadFixture(
  payload: Record<string, any>,
  start: number,
  end: number
): Record<string, any> {
  const requestedPairs = payload.requested_pairs.slice(start, end);
  const paperIds = new Set(requestedPairs.map((pair: Record<string, any>) => pair.paper_id));
  const familyIds = new Set(requestedPairs.map((pair: Record<string, any>) => pair.family_id));
  return {
    version: payload.version,
    term_normalization_version: payload.term_normalization_version,
    candidate_recall_semantics_version: payload.candidate_recall_semantics_version,
    papers: payload.papers.filter((paper: Record<string, any>) => paperIds.has(paper.paper_id)),
    family_contracts: payload.family_contracts.filter(
      (family: Record<string, any>) => familyIds.has(family.family_id)
    ),
    requested_pairs: requestedPairs
  };
}

function buildFunnelFixture(input: {
  candidateCount?: number;
  sourceGapMapSha256?: string;
  researchCycle?: number;
  omitMeaningfulEffect?: boolean;
  probeCandidateCount?: number;
  topicMemoryScenario?: "mixed";
  corpusRawOverride?: string;
} = {}): FunnelFixture {
  const researchCycle = input.researchCycle ?? RESEARCH_CYCLE;
  const evidenceRows = evidenceRowsFixture();
  const evidenceRaw = serializeJsonl(evidenceRows);
  const collectAttemptId = "20260102030405678-genericattempt";
  const semanticLineage = buildSemanticLineageFixture(collectAttemptId);
  const corpusRaw = input.corpusRawOverride
    ?? serializeJsonl(semanticLineage.corpusRows);
  const collectGenerationRaw = JSON.stringify({
    version: 1,
    kind: "collect_generation",
    collect_attempt_id: collectAttemptId
  }, null, 2);
  const collectQualityRaw = JSON.stringify(semanticLineage.quality, null, 2);
  const cluster = {
    cluster_id: "gap_cluster_independent_partition",
    opportunity_type: "explicit_limitation" as const,
    statement: "Prior evaluations omit an independent partition.",
    evidence_ids: evidenceRows.map((row) => row.evidence_id!),
    paper_ids: evidenceRows.map((row) => row.paper_id!)
  };
  const synthesisPayload = {
    schema_version: 2 as const,
    artifact_kind: "research_gap_semantic_synthesis" as const,
    semantics_version: RESEARCH_GAP_SYNTHESIS_SEMANTICS_VERSION,
    prompt_contract_version: RESEARCH_GAP_SYNTHESIS_PROMPT_CONTRACT_VERSION,
    status: "completed" as const,
    method: "llm_proposer_reviewer_deterministic_validation" as const,
    run_id: RUN_ID,
    research_cycle: researchCycle,
    collect_attempt_id: collectAttemptId,
    corpus_sha256: sha256(corpusRaw),
    evidence_sha256: sha256(evidenceRaw),
    generated_at: GENERATED_AT,
    excluded_evidence: [],
    proposed_clusters: [{ ...cluster, rationale: "Two independent full-text works support the same gap." }],
    reviews: [{
      cluster_id: cluster.cluster_id,
      opportunity_type: cluster.opportunity_type,
      decision: "accept" as const,
      statement: cluster.statement,
      accepted_evidence_ids: cluster.evidence_ids,
      validated_conditions: ["same_unresolved_limitation" as const],
      reason: "The limitation is shared and independently grounded."
    }],
    accepted_clusters: [cluster],
    unclustered_evidence_ids: [],
    diagnostics: {
      eligible_evidence_count: evidenceRows.length,
      eligible_evidence_count_by_opportunity_type: {
        explicit_limitation: evidenceRows.length,
        cross_paper_result_disagreement: 0,
        boundary_or_transfer_mismatch: 0,
        missing_comparator_or_control: 0,
        reproducibility_gap: 0
      },
      accepted_cluster_count_by_opportunity_type: {
        explicit_limitation: 1,
        cross_paper_result_disagreement: 0,
        boundary_or_transfer_mismatch: 0,
        missing_comparator_or_control: 0,
        reproducibility_gap: 0
      }
    }
  };
  const synthesis = {
    ...synthesisPayload,
    content_sha256: hashCanonical(synthesisPayload)
  };
  const synthesisRaw = JSON.stringify(synthesis, null, 2);
  const gapMap = buildResearchGapMap({
    evidence: evidenceRows,
    semanticClusters: [{
      statement: cluster.statement,
      evidence_ids: cluster.evidence_ids,
      opportunity_type: cluster.opportunity_type
    }],
    constructionMode: "reviewed_semantic_synthesis",
    synthesisBinding: {
      content_sha256: synthesis.content_sha256,
      semantics_version: synthesis.semantics_version,
      status: synthesis.status
    },
    analysisCoverage: {
      selected_paper_count: 2,
      completed_paper_count: 2,
      failed_paper_ids: [],
      complete: true
    },
    runId: RUN_ID,
    researchCycle,
    collectAttemptId,
    corpusSha256: sha256(corpusRaw),
    corpusByteLength: Buffer.byteLength(corpusRaw, "utf8"),
    evidenceSha256: sha256(evidenceRaw),
    evidenceByteLength: Buffer.byteLength(evidenceRaw, "utf8"),
    generatedAt: GENERATED_AT
  });
  const candidates = Array.from({ length: input.candidateCount ?? 5 }, (_, index) =>
    candidate(
      `candidate_${index + 1}`,
      evidenceRows.map((row) => row.evidence_id!),
      index,
      input.omitMeaningfulEffect === true
    )
  );
  const evidenceAxes = [1, 2, 3].map((index) => ({
    id: `axis_${index}`,
    label: `Evidence axis ${index}`,
    mechanism: `Mechanism ${index} is grounded in the collected evidence.`,
    intervention: `Intervention ${index} isolates a bounded comparison.`,
    evidence_links: evidenceRows.map((row) => row.evidence_id!)
  }));
  const drafts = candidates.map((item) => ({
    ...item,
    run_id: RUN_ID,
    research_cycle: researchCycle,
    supported_gap_ids: resolveSupportedGapIds(item.evidence_links, gapMap)
  }));
  const topicMemoryFixture = input.topicMemoryScenario === "mixed"
    ? buildMixedTopicMemoryFixture(drafts)
    : undefined;
  const reviews = candidates.map((item) => ({
    ...review(item.id),
    run_id: RUN_ID,
    research_cycle: researchCycle
  }));
  const priorAbsorptionMatrix = buildPassingPriorAbsorptionMatrixFixture({
    candidates: drafts,
    evidence: evidenceRows,
    runId: RUN_ID,
    researchCycle,
    generatedAt: GENERATED_AT
  });
  const preliminary = buildTopicPortfolio({
    candidates: drafts,
    reviews,
    probeCandidateIds: candidates
      .slice(0, input.probeCandidateCount ?? 1)
      .map((candidate) => candidate.id),
    evidence: evidenceRows,
    evidenceAxes,
    gapMap,
    runId: RUN_ID,
    researchCycle,
    generatedAt: GENERATED_AT,
    computeBudgetCeiling: makeTopicProbeComputeBudgetLimits(),
    priorAbsorptionMatrix,
    topicMemoryLedger: topicMemoryFixture?.ledger,
    topicReentryTicketsByCandidateId: topicMemoryFixture?.ticketsByCandidateId
  });
  const hypotheses = preliminary.probe_candidate_ids.map((candidateId, index) => {
    const item = drafts.find((draft) => draft.id === candidateId)!;
    return {
      hypothesis_id: `h_${index + 1}`,
      candidate_id: candidateId,
      run_id: RUN_ID,
      research_cycle: researchCycle,
      supported_gap_ids: item.supported_gap_ids,
      text: item.text,
      evidence_links: item.evidence_links,
      axis_ids: item.axis_ids,
      gap_statement: item.gap_statement,
      closest_prior_non_overlap: item.closest_prior_non_overlap,
      reviewer_absorption_objection: item.reviewer_absorption_objection,
      comparator: item.comparator,
      dataset_task_bench: item.dataset_task_bench,
      primary_metric: item.primary_metric,
      metric_unit: item.metric_unit,
      metric_scale: item.metric_scale,
      metric_direction: item.metric_direction,
      effect_criterion: item.effect_criterion,
      objective_raw: preliminary.candidates.find(
        (candidate) => candidate.source_candidate_id === candidateId
      )?.objective_raw,
      meaningful_effect: item.meaningful_effect,
      measurement_signals: item.measurement_signals,
      measurement_hint: item.measurement_hint,
      falsifier: item.falsifier,
      local_budget: item.local_budget,
      kill_signal: item.kill_signal,
      contribution_claim: item.contribution_claim,
      minimum_publishable_evidence: item.minimum_publishable_evidence
    };
  });
  const shortlist = {
    run_id: RUN_ID,
    research_cycle: researchCycle,
    probe_candidate_ids: preliminary.probe_candidate_ids,
    probe_topic_ids: preliminary.probe_topic_ids,
    ranked_candidate_ids: candidates.map((item) => item.id),
    scores: candidates.map((item) => ({ candidate_id: item.id }))
  };
  const raw = {
    gapMap: JSON.stringify(gapMap, null, 2),
    gapSynthesis: synthesisRaw,
    evidence: evidenceRaw,
    corpus: corpusRaw,
    collectGeneration: collectGenerationRaw,
    collectQuality: collectQualityRaw,
    collectSemanticInput: JSON.stringify(semanticLineage.semanticInput, null, 2),
    collectSemanticReview: JSON.stringify(semanticLineage.semanticReview, null, 2),
    collectCandidates: semanticLineage.candidatesRaw,
    collectQueryPlan: JSON.stringify(semanticLineage.queryPlan, null, 2),
    evidenceAxes: `${JSON.stringify(evidenceAxes, null, 2)}\n`,
    priorAbsorptionMatrix:
      `${JSON.stringify(priorAbsorptionMatrix, null, 2)}\n`,
    hypotheses: serializeJsonl(hypotheses),
    drafts: serializeJsonl(drafts),
    reviews: serializeJsonl(reviews),
    shortlist: JSON.stringify(shortlist, null, 2),
    portfolio: "",
    decision: ""
  };
  const sourceContents = {
    "analysis/gap_map.json": raw.gapMap,
    "hypothesis_generation/evidence_axes.json": raw.evidenceAxes,
    "hypothesis_generation/prior_absorption_matrix.json":
      raw.priorAbsorptionMatrix,
    "hypotheses.jsonl": raw.hypotheses,
    "hypothesis_generation/drafts.jsonl": raw.drafts,
    "hypothesis_generation/reviews.jsonl": raw.reviews,
    "hypothesis_generation/probe_shortlist.json": raw.shortlist
  } as const;
  const portfolio = buildTopicPortfolio({
    candidates: drafts,
    reviews,
    probeCandidateIds: shortlist.probe_candidate_ids,
    evidence: evidenceRows,
    evidenceAxes,
    gapMap,
    runId: RUN_ID,
    researchCycle,
    generatedAt: GENERATED_AT,
    computeBudgetCeiling: makeTopicProbeComputeBudgetLimits(),
    sourceArtifactBindings: RESEARCH_FUNNEL_SOURCE_ARTIFACT_PATHS.map((artifactPath) =>
      buildResearchFunnelArtifactBinding(artifactPath, sourceContents[artifactPath])
    ),
    sourceGapMapSha256: input.sourceGapMapSha256,
    priorAbsorptionMatrix,
    topicMemoryLedger: topicMemoryFixture?.ledger,
    topicReentryTicketsByCandidateId: topicMemoryFixture?.ticketsByCandidateId
  });
  raw.portfolio = JSON.stringify(portfolio, null, 2);
  const upstreamValidation = validateResearchFunnelClosedChain({
    expectedRunId: RUN_ID,
    expectedResearchCycle: researchCycle,
    gapMapRaw: raw.gapMap,
    evidenceAxesRaw: raw.evidenceAxes,
    priorAbsorptionMatrixRaw: raw.priorAbsorptionMatrix,
    hypothesesRaw: raw.hypotheses,
    draftsRaw: raw.drafts,
    reviewsRaw: raw.reviews,
    probeShortlistRaw: raw.shortlist,
    portfolioRaw: raw.portfolio,
    requireDecision: false,
    ...closedChainGapValidationInput({
      researchCycle,
      corpusRaw,
      evidenceRaw,
      synthesisRaw,
      collectGenerationRaw
    })
  });
  const decision = buildTopicDecision({
    runId: RUN_ID,
    researchCycle,
    validation: upstreamValidation,
    generatedAt: GENERATED_AT
  });
  raw.decision = JSON.stringify(decision, null, 2);
  return { gapMap, portfolio, decision, raw };
}

async function writeAuthorizedExecutionFixture(
  runDir: string,
  fixture: FunnelFixture
): Promise<{
  activeProbe: ActiveTopicProbeContract;
  parentCorpusRevisionPath: string;
}> {
  const researchCycle = fixture.decision.research_cycle;
  if (researchCycle < 1) {
    throw new Error("authorized_execution_fixture_requires_backtracked_cycle");
  }
  const selectedCandidateId = fixture.decision.probe_candidate_ids[0]!;
  const portfolioCandidate = fixture.portfolio.candidates.find(
    (candidate) => candidate.source_candidate_id === selectedCandidateId
  )!;
  const sourceCandidate = parseJsonl(fixture.raw.drafts).find(
    (candidate) => candidate.id === selectedCandidateId
  ) as unknown as HypothesisCandidate;
  const candidateContract = buildPriorAbsorptionCandidateContract(sourceCandidate);
  const collectGeneration = JSON.parse(fixture.raw.collectGeneration) as {
    collect_attempt_id: string;
  };
  const currentAttemptId = collectGeneration.collect_attempt_id;
  const parentAttemptId = "20260101000000000-parentprior";
  const selectedDirectPriorIds = portfolioCandidate.closest_prior_full_text_paper_ids.slice(0, 1);
  if (selectedDirectPriorIds.length === 0) {
    throw new Error("authorized_execution_fixture_requires_full_text_prior");
  }
  const plan = buildCandidatePriorSearchPlan({
    runId: RUN_ID,
    researchCycle: researchCycle - 1,
    generatedAt: GENERATED_AT,
    asOfDate: GENERATED_AT.slice(0, 10),
    sourceCorpus: {
      collect_attempt_id: parentAttemptId,
      sha256: sha256(fixture.raw.corpus),
      byte_length: Buffer.byteLength(fixture.raw.corpus, "utf8")
    },
    candidates: [{ candidate: sourceCandidate, candidateContract }]
  });
  const candidateFamilyIds = plan.candidates.flatMap((candidatePlan) =>
    candidatePlan.families.map((family) => family.family_id)
  );
  const resultCorpusRaw = serializeJsonl(
    parseJsonl(fixture.raw.corpus).map((row) => {
      if (row.paper_id !== selectedDirectPriorIds[0]) {
        return row;
      }
      const existingFamilies = Array.isArray(row.query_families)
        ? row.query_families.filter((value): value is string => typeof value === "string")
        : [];
      return {
        ...row,
        query_families: [...new Set([...existingFamilies, ...candidateFamilyIds])].sort()
      };
    })
  );
  const authorizedFixture = buildFunnelFixture({
    researchCycle,
    corpusRawOverride: resultCorpusRaw
  });
  const authorizedCandidateId = authorizedFixture.decision.probe_candidate_ids[0];
  if (authorizedCandidateId !== selectedCandidateId) {
    throw new Error("authorized_execution_fixture_candidate_changed_after_rebind");
  }
  const authorizedPortfolioCandidate = authorizedFixture.portfolio.candidates.find(
    (candidate) => candidate.source_candidate_id === selectedCandidateId
  );
  if (!authorizedPortfolioCandidate) {
    throw new Error("authorized_execution_fixture_candidate_missing_after_rebind");
  }
  await writeFunnelFixture(runDir, authorizedFixture);
  const receipt = buildCandidatePriorSearchReceipt({
    plan,
    collectAttemptId: currentAttemptId,
    generatedAt: GENERATED_AT,
    resultCorpusSha256: sha256(resultCorpusRaw),
    resultCorpusByteLength: Buffer.byteLength(resultCorpusRaw, "utf8"),
    attempts: plan.candidates.flatMap((candidate) =>
      candidate.families.flatMap((family) =>
        family.lanes.map((lane) => ({
          familyId: family.family_id,
          retrievalLane: lane.retrieval_lane,
          query: family.query,
          fetched: selectedDirectPriorIds.length,
          selected: selectedDirectPriorIds.length,
          selectedPaperIds: selectedDirectPriorIds
        }))
      )
    )
  });
  const reviewBinding = buildCandidatePriorSearchReviewBindings(receipt).get(
    selectedCandidateId
  );
  if (!reviewBinding) {
    throw new Error("authorized_execution_fixture_requires_prior_review_binding");
  }
  const priorDecisionPayload = {
    schema_version: 1 as const,
    artifact_kind: "candidate_prior_search_decision" as const,
    run_id: RUN_ID,
    research_cycle: researchCycle,
    generated_at: GENERATED_AT,
    collect_attempt_id: currentAttemptId,
    completed_rounds: 1,
    max_rounds: 2,
    current_receipt_status: "valid" as const,
    action: "already_searched" as const,
    candidates: [{
      candidate_id: selectedCandidateId,
      prior_absorption_contract_sha256: candidateContract.content_sha256,
      reason_codes: [],
      absorbed_by_prior: false,
      covered_by_valid_receipt: true,
      selected_direct_prior_ids: selectedDirectPriorIds,
      selected_prior_coverage_complete: true,
      review_binding: reviewBinding,
      probe_eligible: true,
      selected_for_search: false
    }],
    plan_content_sha256: plan.content_sha256
  };
  const priorDecision = {
    ...priorDecisionPayload,
    content_sha256: hashCanonical(priorDecisionPayload)
  };
  const candidatePriorQueryPlan = {
    ...TOPIC_DISCOVERY_COLLECT_QUERY_PLAN_CONTRACT,
    collect_attempt_id: currentAttemptId,
    research_mode: "topic_discovery",
    strategy: "candidate_prior_portfolio",
    planner: {
      source: "candidate_prior_plan",
      queries: plan.candidates.flatMap((candidate) =>
        candidate.families.map((family) => family.query)
      ),
      assumptions: [],
      candidate_prior_search_plan_sha256: plan.content_sha256
    },
    candidate_prior_search_plan: plan,
    selected_families: plan.candidates.flatMap((candidate) =>
      candidate.families.flatMap((family) =>
        family.lanes.map((lane) => ({
          query: family.query,
          query_family: family.family_id,
          retrieval_lane: lane.retrieval_lane,
          source: "candidate_prior_plan",
          source_reason:
            `candidate_prior:${candidate.candidate_id}:`
            + `${family.query_intent}:${lane.retrieval_lane}`,
          reason: "llm_generated",
          retrieval_intent: "topic_discovery",
          sort: lane.sort,
          filters: lane.publication_date_range
            ? {
                publicationDateOrYear:
                  `${lane.publication_date_range.start_date}:`
                  + lane.publication_date_range.end_date
              }
            : {}
        }))
      )
    )
  };
  const parentQueryPlan = {
    ...(JSON.parse(fixture.raw.collectQueryPlan) as Record<string, unknown>),
    collect_attempt_id: parentAttemptId,
    strategy: "topic_portfolio"
  };
  const parentQuality = {
    ...(JSON.parse(fixture.raw.collectQuality) as Record<string, unknown>),
    collect_attempt_id: parentAttemptId
  };
  const parentSemanticInput = {
    ...(JSON.parse(fixture.raw.collectSemanticInput) as Record<string, unknown>),
    collect_attempt_id: parentAttemptId
  };
  const parentSemanticReview = {
    ...(JSON.parse(fixture.raw.collectSemanticReview) as Record<string, unknown>),
    collect_attempt_id: parentAttemptId
  };
  const parentCandidates = serializeJsonl(
    parseJsonl(fixture.raw.collectCandidates).map((candidate) => ({
      ...candidate,
      collect_attempt_id: parentAttemptId
    }))
  );
  const parentArtifacts = new Map<string, string>([
    ["collect_query_plan.json", JSON.stringify(parentQueryPlan, null, 2)],
    ["collect_corpus_quality.json", JSON.stringify(parentQuality, null, 2)],
    [
      "collect_semantic_review_input.json",
      JSON.stringify(parentSemanticInput, null, 2)
    ],
    ["collect_semantic_review.json", JSON.stringify(parentSemanticReview, null, 2)],
    ["collect_topic_discovery_candidates.jsonl", parentCandidates],
    ["corpus.jsonl", fixture.raw.corpus]
  ]);
  const currentArtifacts = new Map<string, string>([
    ["collect_query_plan.json", JSON.stringify(candidatePriorQueryPlan, null, 2)],
    ["collect_candidate_prior_search_plan.json", JSON.stringify(plan, null, 2)],
    ["collect_candidate_prior_search_receipt.json", JSON.stringify(receipt, null, 2)],
    ["corpus.jsonl", resultCorpusRaw]
  ]);
  const activeProbe = buildActiveTopicProbeContract({
    runId: RUN_ID,
    researchCycle,
    researchMode: "topic_discovery",
    portfolioContentSha256: authorizedFixture.portfolio.content_sha256,
    candidate: authorizedPortfolioCandidate,
    generatedAt: GENERATED_AT
  });
  const experimentContract = buildProjectionExperimentContract(
    makeProjectionRun(researchCycle)
  );
  const baseProtocol = estimatorProtocolFixture();
  const estimatorArtifacts = buildEstimatorFeasibilityArtifacts({
    runId: RUN_ID,
    activeProbeSha256: activeProbe.content_sha256,
    experimentContract,
    estimatorProtocol: {
      ...baseProtocol,
      pairing: {
        ...baseProtocol.pairing,
        independent_clusters: 40
      }
    }
  });
  if (estimatorArtifacts.report.status !== "pass") {
    throw new Error("authorized_execution_fixture_estimator_did_not_pass");
  }

  const parentArchive = await writeCollectAttemptArchiveFixture(
    runDir,
    parentAttemptId,
    parentArtifacts
  );
  await writeCollectAttemptArchiveFixture(runDir, currentAttemptId, currentArtifacts);
  await Promise.all([
    writeRawArtifact(
      runDir,
      "collect_query_plan.json",
      currentArtifacts.get("collect_query_plan.json")!
    ),
    writeRawArtifact(
      runDir,
      "collect_candidate_prior_search_plan.json",
      currentArtifacts.get("collect_candidate_prior_search_plan.json")!
    ),
    writeRawArtifact(
      runDir,
      "collect_candidate_prior_search_receipt.json",
      currentArtifacts.get("collect_candidate_prior_search_receipt.json")!
    ),
    writeRawArtifact(runDir, "corpus.jsonl", resultCorpusRaw),
    writeRawArtifact(
      runDir,
      "collect_result.json",
      JSON.stringify({
        collect_attempt_id: currentAttemptId,
        completed: true,
        stored: parseJsonl(resultCorpusRaw).length
      }, null, 2)
    ),
    writeRawArtifact(
      runDir,
      "collect_corpus_quality.json",
      parentArtifacts.get("collect_corpus_quality.json")!
    ),
    writeRawArtifact(
      runDir,
      "collect_semantic_review_input.json",
      parentArtifacts.get("collect_semantic_review_input.json")!
    ),
    writeRawArtifact(
      runDir,
      "collect_semantic_review.json",
      parentArtifacts.get("collect_semantic_review.json")!
    ),
    writeRawArtifact(
      runDir,
      "collect_topic_discovery_candidates.jsonl",
      parentArtifacts.get("collect_topic_discovery_candidates.jsonl")!
    ),
    writeRawArtifact(
      runDir,
      "hypothesis_generation/candidate_prior_search_decision.json",
      JSON.stringify(priorDecision, null, 2)
    ),
    writeRawArtifact(
      runDir,
      "design_experiments_panel/active_topic_probe_contract.json",
      JSON.stringify(activeProbe, null, 2)
    ),
    writeRawArtifact(
      runDir,
      ESTIMATOR_FEASIBILITY_CANDIDATE_EXPERIMENT_CONTRACT_RELATIVE_PATH,
      JSON.stringify(experimentContract, null, 2)
    ),
    writeRawArtifact(
      runDir,
      ESTIMATOR_FEASIBILITY_CONTRACT_RELATIVE_PATH,
      JSON.stringify(estimatorArtifacts.contract, null, 2)
    ),
    writeRawArtifact(
      runDir,
      ESTIMATOR_FEASIBILITY_REPORT_RELATIVE_PATH,
      JSON.stringify(estimatorArtifacts.report, null, 2)
    ),
    writeRawArtifact(
      runDir,
      "experiment_contract.json",
      JSON.stringify(experimentContract, null, 2)
    )
  ]);
  return {
    activeProbe,
    parentCorpusRevisionPath: parentArchive.artifactPaths.get("corpus.jsonl")!
  };
}

async function writeCollectAttemptArchiveFixture(
  runDir: string,
  attemptId: string,
  artifacts: ReadonlyMap<string, string>
): Promise<{ artifactPaths: Map<string, string> }> {
  const snapshots = [...artifacts].map(([sourcePath, content]) => ({
    sourcePath,
    content,
    sha256: sha256(content),
    byteSize: Buffer.byteLength(content, "utf8")
  }));
  const revisionHash = sha256(JSON.stringify({
    collect_attempt_id: attemptId,
    run_id: RUN_ID,
    status: "quality_gate_passed",
    phase: "collection",
    files: snapshots.map((snapshot) => ({
      source_path: snapshot.sourcePath,
      sha256: snapshot.sha256,
      byte_size: snapshot.byteSize
    }))
  }));
  const revisionId = `collection-${revisionHash.slice(0, 20)}`;
  const files = snapshots.map((snapshot) => ({
    source_path: snapshot.sourcePath,
    archived_path:
      `collect_attempts/${attemptId}/revisions/${revisionId}/artifacts/`
      + snapshot.sourcePath,
    sha256: snapshot.sha256,
    byte_size: snapshot.byteSize
  }));
  const manifest = {
    version: 2,
    kind: "collect_attempt_archive",
    collect_attempt_id: attemptId,
    run_id: RUN_ID,
    status: "quality_gate_passed",
    phase: "collection",
    revision_id: revisionId,
    archived_at: GENERATED_AT,
    files
  };
  await Promise.all([
    writeRawArtifact(
      runDir,
      `collect_attempts/${attemptId}/manifest.json`,
      JSON.stringify(manifest, null, 2)
    ),
    writeRawArtifact(
      runDir,
      `collect_attempts/${attemptId}/revisions/${revisionId}/manifest.json`,
      JSON.stringify(manifest, null, 2)
    ),
    ...snapshots.flatMap((snapshot, index) => [
      writeRawArtifact(
        runDir,
        `collect_attempts/${attemptId}/${snapshot.sourcePath}`,
        snapshot.content
      ),
      writeRawArtifact(runDir, files[index]!.archived_path, snapshot.content)
    ])
  ]);
  return {
    artifactPaths: new Map(
      files.map((file) => [file.source_path, file.archived_path] as const)
    )
  };
}

async function createRunDir(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-research-funnel-"));
  const runDir = path.join(root, ".autolabos", "runs", RUN_ID);
  await fs.mkdir(runDir, { recursive: true });
  createdRoots.push(root);
  return runDir;
}

async function writeFunnelFixture(runDir: string, fixture: FunnelFixture): Promise<void> {
  await Promise.all([
    writeRawArtifact(runDir, "analysis/gap_map.json", fixture.raw.gapMap),
    writeRawArtifact(runDir, "analysis/gap_synthesis.json", fixture.raw.gapSynthesis),
    writeRawArtifact(runDir, "evidence_store.jsonl", fixture.raw.evidence),
    writeRawArtifact(runDir, "corpus.jsonl", fixture.raw.corpus),
    writeRawArtifact(runDir, "collect_generation.json", fixture.raw.collectGeneration),
    writeRawArtifact(runDir, "collect_corpus_quality.json", fixture.raw.collectQuality),
    writeRawArtifact(
      runDir,
      "collect_semantic_review_input.json",
      fixture.raw.collectSemanticInput
    ),
    writeRawArtifact(
      runDir,
      "collect_semantic_review.json",
      fixture.raw.collectSemanticReview
    ),
    writeRawArtifact(
      runDir,
      "collect_topic_discovery_candidates.jsonl",
      fixture.raw.collectCandidates
    ),
    writeRawArtifact(runDir, "collect_query_plan.json", fixture.raw.collectQueryPlan),
    writeRawArtifact(
      runDir,
      "hypothesis_generation/evidence_axes.json",
      fixture.raw.evidenceAxes
    ),
    writeRawArtifact(
      runDir,
      "hypothesis_generation/prior_absorption_matrix.json",
      fixture.raw.priorAbsorptionMatrix
    ),
    writeRawArtifact(runDir, "hypotheses.jsonl", fixture.raw.hypotheses),
    writeRawArtifact(runDir, "hypothesis_generation/drafts.jsonl", fixture.raw.drafts),
    writeRawArtifact(runDir, "hypothesis_generation/reviews.jsonl", fixture.raw.reviews),
    writeRawArtifact(runDir, "hypothesis_generation/probe_shortlist.json", fixture.raw.shortlist),
    writeRawArtifact(runDir, "hypothesis_generation/topic_portfolio.json", fixture.raw.portfolio),
    writeRawArtifact(runDir, "design_experiments_panel/topic_decision.json", fixture.raw.decision)
  ]);
}

async function writeRawArtifact(runDir: string, relativePath: string, raw: string): Promise<void> {
  const artifactPath = path.join(runDir, relativePath);
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, raw, "utf8");
}

function replaceSourceBinding(
  portfolio: TopicPortfolio,
  artifactPath: (typeof RESEARCH_FUNNEL_SOURCE_ARTIFACT_PATHS)[number],
  content: string
): TopicPortfolio {
  const changed = structuredClone(portfolio);
  const index = changed.source_artifact_bindings.findIndex((binding) => binding.path === artifactPath);
  changed.source_artifact_bindings[index] = buildResearchFunnelArtifactBinding(artifactPath, content);
  const { content_sha256: _contentHash, ...payload } = changed;
  return { ...payload, content_sha256: hashCanonical(payload) };
}

function rehashDecision(decision: TopicDecision): TopicDecision {
  const { content_sha256: _contentHash, ...payload } = decision;
  return { ...payload, content_sha256: hashCanonical(payload) };
}

function serializeJsonl(items: unknown[]): string {
  return items.length > 0 ? `${items.map((item) => JSON.stringify(item)).join("\n")}\n` : "";
}

function parseJsonl(raw: string): Array<Record<string, unknown>> {
  return raw.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function evidenceRowsFixture(): PriorAbsorptionEvidenceSeed[] {
  return [
    evidence("evidence_methods", "prior_methods", "Prior evaluations omit an independent partition."),
    evidence("evidence_audit", "prior_audit", "Prior evaluations omit an independent partition.")
  ];
}

function evidence(
  evidenceId: string,
  paperId: string,
  limitation: string
): PriorAbsorptionEvidenceSeed {
  return {
    evidence_id: evidenceId,
    paper_id: paperId,
    canonical_work_id: `work_${paperId}`,
    claim: "A measured outcome was reported.",
    method_slot: "The prior evaluates a declared comparison mechanism.",
    result_slot: "The prior reports a matched comparison result.",
    limitation_slot: limitation,
    limitation_kind: "scientific",
    dataset_slot: "evaluation_fixture",
    metric_slot: "primary_score",
    source_type: "full_text",
    source_scope: "full_document",
    grounding_status: "grounded_span",
    evidence_span: limitation,
    confidence: 0.9
  };
}

function closedChainGapValidationInput(input: {
  researchCycle: number;
  corpusRaw: string;
  evidenceRaw: string;
  synthesisRaw: string;
  collectGenerationRaw: string;
}) {
  const chain = buildResearchGapEvidenceChain({
    runId: RUN_ID,
    researchCycle: input.researchCycle,
    corpusRaw: input.corpusRaw,
    evidenceRaw: input.evidenceRaw,
    synthesisRaw: input.synthesisRaw,
    collectGenerationRaw: input.collectGenerationRaw
  });
  return {
    gapValidationContext: chain.validationContext,
    gapValidationReasonCodes: chain.reasonCodes
  };
}

function sha256(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function candidate(
  id: string,
  evidenceLinks: string[],
  index: number,
  omitMeaningfulEffect = false
): HypothesisCandidate {
  const fixtureScope = CANDIDATE_FIXTURE_SCOPES[index % CANDIDATE_FIXTURE_SCOPES.length]!;
  const effectCriterion = {
    basis: "delta_vs_reference" as const,
    magnitude: 0.05,
    scale: "proportion" as const,
    inclusive: true
  };
  const objectiveContract = {
    primary_metric: "primary_score",
    metric_unit: "proportion",
    metric_scale: "proportion" as const,
    metric_direction: "maximize" as const,
    comparator: "Matched-budget comparator",
    effect_criterion: effectCriterion
  };
  return {
    id,
    text: `Candidate intervention ${id} changes the primary outcome.`,
    novelty: 4,
    feasibility: 4,
    testability: 5,
    cost: 2,
    expected_gain: 3,
    evidence_links: evidenceLinks,
    axis_ids: [`axis_${(index % 3) + 1}`],
    gap_statement: "Prior evaluations omit an independent comparison context.",
    closest_prior_non_overlap: "The intervention measures a boundary absent from both closest priors.",
    reviewer_absorption_objection: "A reviewer may argue that a matched comparator absorbs the intervention.",
    comparator: "Matched-budget comparator",
    dataset_task_bench: fixtureScope.data,
    primary_metric: "primary_score",
    metric_unit: "proportion",
    metric_scale: "proportion",
    metric_direction: "maximize",
    effect_criterion: effectCriterion,
    objective_raw: buildCandidateObjectiveRaw(objectiveContract),
    ...(omitMeaningfulEffect
      ? {}
      : { meaningful_effect: "At least 0.05 over the declared comparator." }),
    measurement_signals: ["primary_score", "uncertainty_interval"],
    measurement_hint: "Compare the primary score with uncertainty across repeated matched runs.",
    falsifier: "The prespecified interval includes the null margin.",
    local_budget: makeTopicProbeComputeBudgetDeclaration(),
    brief_compute_budget_ceiling: makeTopicProbeComputeBudgetLimits(),
    kill_signal: "Stop when the comparator cannot execute.",
    contribution_claim: fixtureScope.contribution,
    minimum_publishable_evidence: "Repeated comparisons with uncertainty intervals and failure analysis."
  };
}

function buildMixedTopicMemoryFixture(candidates: HypothesisCandidate[]): {
  ledger: TopicMemoryLedger;
  ticketsByCandidateId: Map<string, TopicReentryTicket>;
} {
  let ledger = createTopicMemoryLedger();
  const ticketsByCandidateId = new Map<string, TopicReentryTicket>();
  for (const [index, item] of candidates.slice(0, 3).entries()) {
    const currentDescriptor = buildTopicFormulationDescriptor({
      statement: item.text,
      gap_statement: item.gap_statement,
      contribution_claim: item.contribution_claim,
      dataset_task_bench: item.dataset_task_bench,
      comparator: item.comparator,
      primary_metric: item.primary_metric,
      metric_unit: item.metric_unit,
      meaningful_effect: item.meaningful_effect,
      minimum_publishable_evidence: item.minimum_publishable_evidence
    });
    const killedDescriptor = index === 0
      ? currentDescriptor
      : buildTopicFormulationDescriptor({
          statement: `Earlier mechanism for ${item.id} changes the primary outcome.`,
          gap_statement: item.gap_statement,
          contribution_claim: item.contribution_claim,
          dataset_task_bench: item.dataset_task_bench,
          comparator: item.comparator,
          primary_metric: item.primary_metric,
          metric_unit: item.metric_unit,
          meaningful_effect: item.meaningful_effect,
          minimum_publishable_evidence: item.minimum_publishable_evidence
        });
    ledger = appendTopicKillRecord(ledger, {
      descriptor: killedDescriptor,
      kill_scope: "exact_formulation",
      disposition_category: "bounded_probe_rejected",
      public_reason_codes: ["bounded_probe_hypothesis_not_supported"],
      source_run_id: `topic_memory_source_${index + 1}`,
      source_research_cycle: 0,
      source_full_text_evidence_ids: [`historical_${index + 1}`],
      source_topic_content_sha256: hashCanonical({ kind: "topic", index }),
      source_decision_content_sha256: hashCanonical({ kind: "decision", index })
    });
    if (index === 2) {
      const priorRecord = ledger.records[ledger.records.length - 1]!;
      ticketsByCandidateId.set(item.id, buildTopicReentryTicket({
        priorRecordSha256: priorRecord.record_sha256,
        changedAxes: ["method_mechanism"],
        newFullTextEvidenceIds: ["fresh_evidence_a", "fresh_evidence_b"],
        proposedFormulationSha256: currentDescriptor.formulation_sha256,
        ledgerHeadSha256: ledger.ledger_sha256,
        issuerId: "fixture-independent-reviewer",
        decisionArtifactSha256: hashCanonical({
          kind: "reentry_decision",
          candidate_id: item.id
        }),
        rationale: "The revised mechanism is supported by new independent evidence."
      }));
    }
  }
  return { ledger, ticketsByCandidateId };
}

function analysisReport(
  contract: ActiveTopicProbeContract,
  evidenceContract: EvidenceAdequacyContractV2,
  assessment: EvidenceAdequacyAssessmentV2
): AnalysisReport {
  const delta = 0.06;
  const referenceValue = 0.5;
  const executionBinding = buildTopicProbeExecutionBinding({
    candidateId: contract.candidate_id,
    candidateContentSha256: contract.candidate_content_sha256,
    comparator: contract.comparator,
    datasetTaskScope: contract.dataset_task_bench
  });
  const candidateBinding = buildCandidateObjectiveProfileBinding({
    candidateId: contract.candidate_id,
    primaryMetric: contract.primary_metric,
    metricUnit: contract.metric_unit,
    metricScale: contract.metric_scale,
    metricDirection: contract.metric_direction,
    comparator: contract.comparator,
    effectCriterion: contract.effect_criterion,
    objectiveRaw: contract.objective_raw
  });
  return {
    analysis_version: 1,
    objective_metric: {
      profile: {
        candidate_contract: candidateBinding
      }
    },
    results_plan: {
      schema_version: "2.0",
      required_metrics: [{
        id: contract.primary_metric,
        label: contract.primary_metric,
        direction: "higher_better",
        unit: contract.metric_unit
      }],
      minimum_series_count: 2,
      minimum_comparison_count: 1,
      required_series: [
        { id: executionBinding.subject_series_id, role: "primary" },
        { id: executionBinding.reference_series_id, role: "baseline" }
      ],
      required_comparisons: [{
        id: executionBinding.primary_comparison_id,
        subject_series_id: executionBinding.subject_series_id,
        reference_series_id: executionBinding.reference_series_id,
        metric_id: contract.primary_metric,
        scope: executionBinding.observation_scope
      }],
      primary_comparison_id: executionBinding.primary_comparison_id,
      primary_effect_criterion: {
        comparison_id: executionBinding.primary_comparison_id,
        metric_id: contract.primary_metric,
        metric_scale: contract.metric_scale,
        direction: contract.metric_direction,
        effect_criterion: contract.effect_criterion
      }
    },
    primary_comparison_id: executionBinding.primary_comparison_id,
    results_artifact: {
      schema_version: "2.0",
      metrics: [{
        id: contract.primary_metric,
        label: "Primary score",
        direction: "higher_better",
        unit: contract.metric_unit
      }],
      series: [
        {
          id: executionBinding.subject_series_id,
          label: "Candidate condition",
          role: "primary",
          dimensions: {}
        },
        {
          id: executionBinding.reference_series_id,
          label: "Reference condition",
          role: "baseline",
          dimensions: {}
        }
      ],
      observations: [
        {
          id: "observation_candidate",
          series_id: executionBinding.subject_series_id,
          metric_id: contract.primary_metric,
          scope: executionBinding.observation_scope,
          value: referenceValue + delta,
          evidence_refs: ["metrics.json#/candidate"]
        },
        {
          id: "observation_reference",
          series_id: executionBinding.reference_series_id,
          metric_id: contract.primary_metric,
          scope: executionBinding.observation_scope,
          value: referenceValue,
          evidence_refs: ["metrics.json#/reference"]
        }
      ],
      comparisons: [{
        id: executionBinding.primary_comparison_id,
        subject_observation_id: "observation_candidate",
        reference_observation_id: "observation_reference",
        delta,
        judgement: "supported",
        evidence_refs: ["metrics.json#/comparison"]
      }]
    },
    statistical_summary: {
      executed_trials: 2,
      cached_trials: 0,
      confidence_intervals: [{
        metric_key: contract.primary_metric,
        comparison_id: executionBinding.primary_comparison_id,
        estimand: "effect_delta",
        metric_scale: contract.metric_scale,
        trial_source: "fresh_executed",
        method: evidenceContract.uncertainty_requirement.allowed_methods[0],
        label: "Primary interval",
        lower: 0.05,
        upper: 0.07,
        level: 0.95,
        sample_size: 2,
        source: "metrics",
        summary: "Interval over fresh bounded trials."
      }],
      stability_metrics: [],
      effect_estimates: [{
        comparison_id: executionBinding.primary_comparison_id,
        metric_key: contract.primary_metric,
        delta,
        direction: "positive",
        summary: "Effect estimate for the declared primary comparison."
      }],
      notes: []
    },
    evidence_adequacy_assessment: assessment,
    failure_taxonomy: []
  } as unknown as AnalysisReport;
}

async function loadTopicDiscoveryProjection(
  runDir: string,
  context: { runId?: string; researchCycle?: number } = {}
) {
  const projection = await loadResearchFunnelProjection(runDir, {
    ...context,
    researchMode: "topic_discovery"
  });
  if (!projection) {
    throw new Error("topic_discovery_projection_missing");
  }
  return projection;
}

function makeProjectionRun(researchCycle: number = RESEARCH_CYCLE): RunRecord {
  const graph = createDefaultGraphState();
  graph.researchCycle = researchCycle;
  return {
    version: 3,
    workflowVersion: 3,
    id: RUN_ID,
    title: "Governed projection fixture",
    topic: "A bounded comparison under a declared protocol",
    constraints: [],
    objectiveMetric: "primary_effect >= 0 mean",
    status: "running",
    currentNode: "design_experiments",
    nodeThreads: {},
    createdAt: GENERATED_AT,
    updatedAt: GENERATED_AT,
    graph,
    memoryRefs: {
      runContextPath: `.autolabos/runs/${RUN_ID}/memory/run_context.json`,
      longTermPath: `.autolabos/runs/${RUN_ID}/memory/long_term.jsonl`,
      episodePath: `.autolabos/runs/${RUN_ID}/memory/episodes.jsonl`
    }
  };
}

function buildProjectionExperimentContract(run: RunRecord) {
  return buildExperimentContract({
    run,
    hypothesis: "The declared intervention changes the primary response.",
    causalMechanism: "Only the declared intervention differs between paired arms.",
    singleChange: "Enable the declared intervention.",
    expectedMetricEffect: "The primary response differs from the reference.",
    abortCondition: "Abort when a declared paired analysis unit is incomplete.",
    keepOrDiscardRule: "Keep only complete paired comparisons.",
    baselines: ["reference"],
    resultsPlan: {
      schema_version: "2.0",
      required_metrics: [{
        id: "primary_effect",
        label: "Primary effect",
        direction: "higher_better",
        unit: "mean"
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
}

function estimatorProtocolFixture(): EstimatorProtocolDeclaration {
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
      independent_clusters: 12,
      observations_per_arm_per_cluster: 1
    },
    outcome: {
      type: "continuous",
      attainable_resolution: 0.01
    },
    estimand: {
      id: "primary_effect",
      type: "paired_mean_difference",
      scale: "mean"
    },
    estimator: {
      family: "paired_mean_difference",
      covariance: "exact_paired",
      separation_policy: "not_applicable"
    },
    power: {
      alpha: 0.05,
      target_power: 0.8,
      minimum_detectable_effect: 0.1,
      assumed_standard_deviation: 0.1,
      sidedness: "two_sided"
    },
    resampling: {
      minimum_clusters: 30,
      replicates: 2_000
    },
    multiplicity: {
      primary_comparison_id: "primary_effect",
      family: ["primary_effect"],
      method: "none",
      family_alpha: 0.05
    }
  };
}

function review(candidateId: string): HypothesisReview {
  return {
    candidate_id: candidateId,
    keep: true,
    groundedness: 4,
    causal_clarity: 4,
    falsifiability: 4,
    experimentability: 4,
    measurement_specificity: 4,
    measurement_signals: ["repeated_run_variance"],
    measurement_hint: "Compare the primary score with uncertainty across repeated matched runs.",
    limitation_reflection: 4,
    measurement_readiness: 4,
    strengths: ["The comparison is explicit."],
    weaknesses: ["The bounded scope limits generalization."],
    provenance: makeIndependentHypothesisReviewProvenance(candidateId)
  };
}
