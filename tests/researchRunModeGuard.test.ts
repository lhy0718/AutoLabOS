import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";

import { describe, expect, it } from "vitest";

import { resolveResearchRunModeGuard } from "../src/core/runs/researchRunModeGuard.js";
import {
  buildTopicDecision,
  hashCanonical,
  validateTopicPortfolioArtifact
} from "../src/core/researchFunnel.js";
import { buildActiveTopicProbeContract } from "../src/core/activeTopicProbeContract.js";
import { buildTopicProbeFollowupHandoff } from "../src/core/topicProbeFollowup.js";
import type { TopicProbeOutcomeDecision } from "../src/core/topicProbeOutcome.js";
import {
  buildTopicProbeReviewGate
} from "../src/core/topicProbeReviewGate.js";
import {
  buildTopicProbeFollowupRunReceipt,
  TOPIC_PROBE_FOLLOWUP_RECEIPT_RELATIVE_PATH
} from "../src/core/topicProbeFollowupRun.js";
import {
  buildTopicProbeSuccessorLineageManifest,
  serializeTopicProbeSuccessorLineageManifest,
  TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS,
  TOPIC_PROBE_SUCCESSOR_LINEAGE_MANIFEST_RELATIVE_PATH
} from "../src/core/runs/topicProbeSuccessorLineage.js";
import type { RunRecord } from "../src/types.js";
import {
  ACTIVE_TOPIC_PROBE_CONTRACT_RELATIVE_PATH,
  TOPIC_PROBE_DECISION_RELATIVE_PATH,
  TOPIC_PROBE_PORTFOLIO_RELATIVE_PATH
} from "../src/core/topicProbeOutcomeArtifacts.js";
import {
  TOPIC_PROBE_FIXTURE_CANDIDATE_IDS,
  buildTopicProbePortfolioFixture
} from "./support/topicProbePortfolioFixture.js";
import { buildVenueViabilityReport } from "../src/core/venueViability.js";

const TOPIC_DISCOVERY_BRIEF = [
  "# Research Brief",
  "",
  "## Research Mode",
  "topic_discovery",
  "",
  "## Topic",
  "A bounded research search scope."
].join("\n");

const HYPOTHESIS_BRIEF = TOPIC_DISCOVERY_BRIEF.replace(
  "topic_discovery",
  "hypothesis_test"
);

describe("research run mode guard", () => {
  it("recovers topic discovery mode from the immutable brief snapshot", async () => {
    const fixture = await createFixture("snapshot-mode");
    await writeFixtureFile(
      fixture.runDir,
      "brief/source_brief.md",
      TOPIC_DISCOVERY_BRIEF
    );
    await writeFixtureFile(
      fixture.runDir,
      "design_experiments_panel/active_topic_probe_contract.json",
      "{}"
    );

    const result = await resolveResearchRunModeGuard({
      workspaceRoot: fixture.root,
      runId: fixture.runId
    });

    expect(result).toMatchObject({
      valid: true,
      effectiveMode: "topic_discovery",
      evidenceStage: "bounded_probe",
      topicProbeLineageDetected: true,
      paperDraftingAllowed: false
    });
  });

  it("fails closed when memory and snapshot research modes disagree", async () => {
    const fixture = await createFixture("mode-mismatch");
    await writeFixtureFile(
      fixture.runDir,
      "brief/source_brief.md",
      TOPIC_DISCOVERY_BRIEF
    );
    await writeFixtureFile(
      fixture.runDir,
      "hypothesis_generation/topic_portfolio.json",
      "{}"
    );

    const result = await resolveResearchRunModeGuard({
      workspaceRoot: fixture.root,
      runId: fixture.runId,
      rawBrief: HYPOTHESIS_BRIEF
    });

    expect(result.valid).toBe(false);
    expect(result.paperDraftingAllowed).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      "research_mode_source_mismatch",
      "bounded_probe_memory_mode_mismatch"
    ]));
  });

  it("allows topic discovery before an execution consumer requires active probe lineage", async () => {
    const fixture = await createFixture("discovery-before-probe-authorization");

    const result = await resolveResearchRunModeGuard({
      workspaceRoot: fixture.root,
      runId: fixture.runId,
      rawBrief: TOPIC_DISCOVERY_BRIEF
    });

    expect(result).toMatchObject({
      valid: true,
      effectiveMode: "topic_discovery",
      evidenceStage: "standard",
      topicProbeLineageDetected: true,
      paperDraftingAllowed: false
    });
    expect(result.reasons).not.toContain(
      "topic_discovery_active_bounded_probe_lineage_missing"
    );
  });

  it.each([
    ["raw brief", true],
    ["immutable snapshot", false]
  ])(
    "fails closed for an execution consumer when topic discovery comes from the %s without active probe lineage",
    async (_source, useRawBrief) => {
      const fixture = await createFixture("discovery-execution-without-lineage");
      if (!useRawBrief) {
        await writeFixtureFile(
          fixture.runDir,
          "brief/source_brief.md",
          TOPIC_DISCOVERY_BRIEF
        );
      }

      const result = await resolveResearchRunModeGuard({
        workspaceRoot: fixture.root,
        runId: fixture.runId,
        rawBrief: useRawBrief ? TOPIC_DISCOVERY_BRIEF : undefined,
        requireActiveBoundedProbeLineage: true
      });

      expect(result.valid).toBe(false);
      expect(result.evidenceStage).toBe("standard");
      expect(result.reasons).toContain(
        "topic_discovery_active_bounded_probe_lineage_missing"
      );
    }
  );

  it("binds an execution consumer to the current portfolio, decision, and active contract", async () => {
    const fixture = await createFixture("bounded-probe-execution-lineage");
    const researchCycle = 2;
    const portfolioFixture = buildTopicProbePortfolioFixture({
      runId: fixture.runId,
      researchCycle
    });
    const portfolioValidation = validateTopicPortfolioArtifact(
      JSON.stringify(portfolioFixture.portfolio),
      {
        expectedRunId: fixture.runId,
        expectedResearchCycle: researchCycle
      }
    );
    const decision = buildTopicDecision({
      runId: fixture.runId,
      researchCycle,
      validation: portfolioValidation,
      generatedAt: "2026-01-01T00:00:00.000Z"
    });
    const active = buildActiveTopicProbeContract({
      runId: fixture.runId,
      researchCycle,
      researchMode: "topic_discovery",
      portfolioContentSha256: portfolioFixture.portfolio.content_sha256,
      candidate: portfolioFixture.portfolio.candidates[0]!
    });
    await Promise.all([
      writeFixtureFile(
        fixture.runDir,
        TOPIC_PROBE_PORTFOLIO_RELATIVE_PATH,
        JSON.stringify(portfolioFixture.portfolio)
      ),
      writeFixtureFile(
        fixture.runDir,
        TOPIC_PROBE_DECISION_RELATIVE_PATH,
        JSON.stringify(decision)
      ),
      writeFixtureFile(
        fixture.runDir,
        ACTIVE_TOPIC_PROBE_CONTRACT_RELATIVE_PATH,
        JSON.stringify(active)
      )
    ]);

    const valid = await resolveResearchRunModeGuard({
      workspaceRoot: fixture.root,
      runId: fixture.runId,
      rawBrief: TOPIC_DISCOVERY_BRIEF,
      expectedResearchCycle: researchCycle,
      requireActiveBoundedProbeLineage: true
    });
    expect(valid.valid).toBe(true);

    const { content_sha256: _hash, ...activePayload } = active;
    const driftedPayload = {
      ...activePayload,
      portfolio_content_sha256: "f".repeat(64)
    };
    await writeFixtureFile(
      fixture.runDir,
      ACTIVE_TOPIC_PROBE_CONTRACT_RELATIVE_PATH,
      JSON.stringify({
        ...driftedPayload,
        content_sha256: hashCanonical(driftedPayload)
      })
    );

    const drifted = await resolveResearchRunModeGuard({
      workspaceRoot: fixture.root,
      runId: fixture.runId,
      rawBrief: TOPIC_DISCOVERY_BRIEF,
      expectedResearchCycle: researchCycle,
      requireActiveBoundedProbeLineage: true
    });
    expect(drifted.valid).toBe(false);
    expect(drifted.reasons).toContain(
      "bounded_probe_execution_active_contract_invalid:active_topic_probe_contract_portfolio_hash_mismatch"
    );
  });

  it("fails closed when topic-probe artifacts survive but both mode sources are missing", async () => {
    const fixture = await createFixture("missing-mode");
    await writeFixtureFile(
      fixture.runDir,
      "design_experiments_panel/topic_decision.json",
      "{}"
    );

    const result = await resolveResearchRunModeGuard({
      workspaceRoot: fixture.root,
      runId: fixture.runId
    });

    expect(result.valid).toBe(false);
    expect(result.effectiveMode).toBe("topic_discovery");
    expect(result.reasons).toContain("bounded_probe_research_mode_missing");
  });

  it("allows a confirmatory child only when the complete lineage chain is bound", async () => {
    const fixture = await createConfirmatoryFixture("confirmatory-child");
    const result = await fixture.resolve();

    expect(result).toMatchObject({
      valid: true,
      effectiveMode: "hypothesis_test",
      evidenceStage: "confirmatory_followup",
      topicProbeLineageDetected: true,
      paperDraftingAllowed: true,
      successorRouteTarget: {
        schema_version: 3,
        policy: "preserve_active_candidate",
        source_active_candidate_id:
          TOPIC_PROBE_FIXTURE_CANDIDATE_IDS[0]
      }
    });
  });

  it("rejects the former brief-and-receipt-only confirmatory declaration", async () => {
    const fixture = await createFixture("former-confirmatory-bypass");
    const receipt = buildFormerConfirmatoryReceipt(
      fixture.runId,
      HYPOTHESIS_BRIEF
    );
    await writeFixtureFile(
      fixture.runDir,
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.sourceBrief,
      HYPOTHESIS_BRIEF
    );
    await writeFixtureFile(
      fixture.runDir,
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.receipt,
      serializeJson(receipt)
    );

    const result = await resolveResearchRunModeGuard({
      workspaceRoot: fixture.root,
      runId: fixture.runId,
      rawBrief: HYPOTHESIS_BRIEF,
      run: {
        id: fixture.runId,
        executionRole: "delegated_once",
        promotionLineage: {
          schemaVersion: 1,
          relation: "topic_probe_confirmatory",
          parentRunId: receipt.parent_run_id,
          parentResearchCycle: receipt.parent_research_cycle,
          outcomeContentSha256: receipt.outcome_content_sha256,
          receiptContentSha256: receipt.content_sha256
        }
      }
    });

    expect(result.paperDraftingAllowed).toBe(false);
    expect(result.reasons).toContain(
      "successor_followup_topic_probe_followup_receipt_schema_invalid"
    );
  });

  it.each([
    [
      "active contract",
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.activeContract,
      "successor_followup_active_contract_missing"
    ],
    [
      "source candidate",
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.sourceCandidate,
      "successor_followup_source_candidate_missing"
    ],
    [
      "handoff",
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.handoff,
      "successor_followup_handoff_missing"
    ],
    [
      "outcome gate",
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.outcomeGate,
      "successor_followup_outcome_gate_missing"
    ],
    [
      "venue viability report",
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.venueViability,
      "successor_followup_venue_viability_missing"
    ],
    [
      "lineage manifest",
      TOPIC_PROBE_SUCCESSOR_LINEAGE_MANIFEST_RELATIVE_PATH,
      "successor_followup_lineage_manifest_missing"
    ],
    [
      "child promotion receipt",
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.receipt,
      "successor_followup_receipt_missing"
    ]
  ])("fails closed when the %s file is deleted", async (_label, relativePath, reason) => {
    const fixture = await createConfirmatoryFixture("deleted-lineage-file");
    await fs.unlink(path.join(fixture.runDir, relativePath));

    const result = await fixture.resolve();

    expect(result.paperDraftingAllowed).toBe(false);
    expect(result.reasons).toContain(reason);
  });

  it("fails closed when the parent promotion receipt is deleted", async () => {
    const fixture = await createConfirmatoryFixture("parent-receipt-deleted");
    await fs.unlink(path.join(
      fixture.parentRunDir,
      TOPIC_PROBE_FOLLOWUP_RECEIPT_RELATIVE_PATH
    ));

    const result = await fixture.resolve();

    expect(result.paperDraftingAllowed).toBe(false);
    expect(result.reasons).toContain(
      "successor_followup_parent_promotion_receipt_missing"
    );
  });

  it("fails closed on a byte-only mutation even when canonical JSON is unchanged", async () => {
    const fixture = await createConfirmatoryFixture("byte-mutation");
    const candidatePath = path.join(
      fixture.runDir,
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.sourceCandidate
    );
    await fs.appendFile(candidatePath, " ", "utf8");

    const result = await fixture.resolve();

    expect(result.paperDraftingAllowed).toBe(false);
    expect(result.reasons).toContain(
      "successor_followup_source_candidate_file_hash_mismatch"
    );
  });

  it("fails closed when the child outcome gate is self-rehashed with a different disposition", async () => {
    const fixture = await createConfirmatoryFixture("outcome-gate-mutation");
    const outcomeGatePath = path.join(
      fixture.runDir,
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.outcomeGate
    );
    const outcomeGate = JSON.parse(
      await fs.readFile(outcomeGatePath, "utf8")
    ) as Record<string, unknown>;
    const { content_sha256: _oldHash, ...payload } = outcomeGate;
    const changedPayload = {
      ...payload,
      disposition: "repeat_probe"
    };
    await writeFixtureFile(
      fixture.runDir,
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.outcomeGate,
      serializeJson({
        ...changedPayload,
        content_sha256: hashCanonical(changedPayload)
      })
    );

    const result = await fixture.resolve();

    expect(result.paperDraftingAllowed).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      "successor_followup_outcome_gate_file_hash_mismatch",
      "successor_followup_outcome_gate_manifest_content_hash_mismatch",
      "successor_followup_outcome_gate_invalid:topic_probe_outcome_gate_disposition_mismatch"
    ]));
  });

  it("fails closed when the source contract no longer matches the promotion receipt", async () => {
    const fixture = await createConfirmatoryFixture("contract-mismatch");
    const changedPayload = {
      ...fixture.contract,
      statement: "A different frozen statement."
    };
    const { content_sha256: _oldHash, ...payload } = changedPayload;
    const changedContract = {
      ...payload,
      content_sha256: hashCanonical(payload)
    };
    await writeFixtureFile(
      fixture.runDir,
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.activeContract,
      serializeJson(changedContract)
    );

    const result = await fixture.resolve();

    expect(result.paperDraftingAllowed).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      "successor_followup_active_contract_file_hash_mismatch",
      "successor_followup_active_contract_manifest_content_hash_mismatch"
    ]));
  });

  it("revalidates lineage on resume instead of trusting an earlier pass", async () => {
    const fixture = await createConfirmatoryFixture("resume-revalidation");
    expect((await fixture.resolve()).paperDraftingAllowed).toBe(true);
    await fs.appendFile(
      path.join(
        fixture.runDir,
        TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.handoff
      ),
      "\n",
      "utf8"
    );

    const resumed = await fixture.resolve();

    expect(resumed.paperDraftingAllowed).toBe(false);
    expect(resumed.reasons).toContain(
      "successor_followup_handoff_file_hash_mismatch"
    );
  });

  it("fails closed when a confirmatory receipt is only a placeholder file", async () => {
    const fixture = await createFixture("confirmatory-placeholder");
    await writeFixtureFile(fixture.runDir, "brief/source_brief.md", HYPOTHESIS_BRIEF);
    await writeFixtureFile(
      fixture.runDir,
      "governance/topic_probe_followup/receipt.json",
      "{}"
    );

    const result = await resolveResearchRunModeGuard({
      workspaceRoot: fixture.root,
      runId: fixture.runId,
      rawBrief: HYPOTHESIS_BRIEF
    });

    expect(result.valid).toBe(false);
    expect(result.paperDraftingAllowed).toBe(false);
    expect(result.reasons).toContain(
      "successor_followup_topic_probe_followup_receipt_schema_invalid"
    );
  });

  it("preserves the historical hypothesis default only for runs without probe lineage", async () => {
    const fixture = await createFixture("standard-run");

    const result = await resolveResearchRunModeGuard({
      workspaceRoot: fixture.root,
      runId: fixture.runId
    });

    expect(result).toMatchObject({
      valid: true,
      effectiveMode: "hypothesis_test",
      evidenceStage: "standard",
      topicProbeLineageDetected: false,
      paperDraftingAllowed: true
    });
  });
});

async function createFixture(label: string): Promise<{
  root: string;
  runId: string;
  runDir: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `autolabos-${label}-`));
  const runId = randomUUID();
  const runDir = path.join(root, ".autolabos", "runs", runId);
  await fs.mkdir(runDir, { recursive: true });
  return { root, runId, runDir };
}

async function writeFixtureFile(
  runDir: string,
  relativePath: string,
  content: string
): Promise<void> {
  const target = path.join(runDir, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

async function createConfirmatoryFixture(label: string) {
  const fixture = await createFixture(label);
  const parentRunId = randomUUID();
  const parentResearchCycle = 2;
  const { portfolio } = buildTopicProbePortfolioFixture({
    runId: parentRunId,
    researchCycle: parentResearchCycle,
    probeCandidateIds: [TOPIC_PROBE_FIXTURE_CANDIDATE_IDS[0]]
  });
  const candidate = portfolio.candidates.find(
    (item) =>
      item.source_candidate_id === TOPIC_PROBE_FIXTURE_CANDIDATE_IDS[0]
  )!;
  const contract = buildActiveTopicProbeContract({
    runId: parentRunId,
    researchCycle: parentResearchCycle,
    researchMode: "topic_discovery",
    portfolioContentSha256: portfolio.content_sha256,
    candidate,
    generatedAt: "2026-01-01T00:00:00.000Z"
  });
  const outcomePayload: Omit<TopicProbeOutcomeDecision, "content_sha256"> = {
    schema_version: 1,
    artifact_kind: "topic_probe_outcome_decision",
    run_id: parentRunId,
    research_cycle: parentResearchCycle,
    candidate_id: candidate.source_candidate_id,
    topic_id: candidate.topic_id,
    contract_content_sha256: contract.content_sha256,
    primary_comparison_id: "declared_comparison",
    primary_metric: contract.primary_metric,
    observed_delta: 0.2,
    directed_delta: 0.2,
    required_magnitude: contract.effect_criterion.magnitude,
    executed_trials: 2,
    cached_trials: 0,
    primary_metric_ci_present: true,
    primary_effect_ci_directed_bound: 0.15,
    primary_effect_ci_criterion_met: true,
    disposition: "promote_to_confirmatory",
    reason_codes: ["confirmatory_gate_satisfied"],
    evidence_refs: ["result_analysis.json#/comparisons/declared_comparison"],
    next_action: "start_confirmatory_run"
  };
  const outcome: TopicProbeOutcomeDecision = {
    ...outcomePayload,
    content_sha256: hashCanonical(outcomePayload)
  };
  const handoff = buildTopicProbeFollowupHandoff({
    portfolio,
    contract,
    outcome,
    candidate
  });
  const gate = buildTopicProbeReviewGate({
    runId: parentRunId,
    researchCycle: parentResearchCycle,
    outcome,
    handoff
  });
  const outcomeGatePayload = {
    schema_version: 1 as const,
    artifact_kind: "topic_probe_outcome_gate" as const,
    run_id: parentRunId,
    research_cycle: parentResearchCycle,
    status: "decided" as const,
    disposition: outcome.disposition,
    outcome_content_sha256: outcome.content_sha256,
    reason_codes: [...outcome.reason_codes],
    venue_viability_report_contract_version: 1 as const
  };
  const outcomeGate = {
    ...outcomeGatePayload,
    content_sha256: hashCanonical(outcomeGatePayload)
  };
  const venueViability = buildVenueViabilityReport({
    candidate,
    contract,
    outcome
  });
  const brief = handoff.research_brief_markdown;
  const manifest = buildTopicProbeSuccessorLineageManifest({
    relation: "topic_probe_confirmatory",
    disposition: handoff.disposition,
    nextAction: handoff.next_action,
    recommendedFollowupMode: handoff.recommended_followup_mode,
    evidenceStage: handoff.evidence_stage,
    parentRunId,
    parentResearchCycle,
    childRunId: fixture.runId,
    sourceBrief: {
      raw: brief,
      contentSha256: hashCanonical(brief)
    },
    activeContract: lineageSource(contract),
    sourceCandidate: lineageSource(candidate),
    sourcePortfolio: lineageSource(portfolio),
    handoff: lineageSource(handoff),
    boundedOutcome: lineageSource(outcome),
    outcomeGate: lineageSource(outcomeGate),
    venueViability: lineageSource(venueViability),
    reviewGate: lineageSource(gate)
  });
  const manifestRaw = serializeTopicProbeSuccessorLineageManifest(manifest);
  const parentRun = {
    id: parentRunId,
    graph: { researchCycle: parentResearchCycle }
  } as unknown as RunRecord;
  const receipt = buildTopicProbeFollowupRunReceipt({
    parentRun,
    childRunId: fixture.runId,
    handoff,
    outcomeGate,
    venueViability,
    gate,
    lineageManifest: manifest,
    lineageManifestRaw: manifestRaw
  });
  const receiptRaw = serializeJson(receipt);
  const parentRunDir = path.join(
    fixture.root,
    ".autolabos",
    "runs",
    parentRunId
  );
  const childArtifacts: Array<readonly [string, string]> = [
    [TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.sourceBrief, brief],
    [TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.activeContract, serializeJson(contract)],
    [TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.sourceCandidate, serializeJson(candidate)],
    [TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.sourcePortfolio, serializeJson(portfolio)],
    [TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.handoff, serializeJson(handoff)],
    [TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.boundedOutcome, serializeJson(outcome)],
    [TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.outcomeGate, serializeJson(outcomeGate)],
    [TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.venueViability, serializeJson(venueViability)],
    [TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.reviewGate, serializeJson(gate)],
    [TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.receipt, receiptRaw],
    [TOPIC_PROBE_SUCCESSOR_LINEAGE_MANIFEST_RELATIVE_PATH, manifestRaw]
  ];
  await Promise.all(childArtifacts.map(([relativePath, content]) =>
    writeFixtureFile(fixture.runDir, relativePath, content)
  ));
  await writeFixtureFile(
    parentRunDir,
    TOPIC_PROBE_FOLLOWUP_RECEIPT_RELATIVE_PATH,
    receiptRaw
  );

  const run: Pick<RunRecord, "id" | "executionRole" | "promotionLineage"> = {
    id: fixture.runId,
    executionRole: "delegated_once",
    promotionLineage: {
      schemaVersion: 1,
      relation: "topic_probe_confirmatory",
      parentRunId,
      parentResearchCycle,
      outcomeContentSha256: receipt.outcome_content_sha256,
      receiptContentSha256: receipt.content_sha256
    }
  };
  return {
    ...fixture,
    parentRunDir,
    contract,
    receipt,
    resolve: () => resolveResearchRunModeGuard({
      workspaceRoot: fixture.root,
      runId: fixture.runId,
      rawBrief: brief,
      run
    })
  };
}

function lineageSource(artifact: { content_sha256: string }) {
  return {
    raw: serializeJson(artifact),
    contentSha256: artifact.content_sha256
  };
}

function buildFormerConfirmatoryReceipt(childRunId: string, brief: string) {
  const payload = {
    schema_version: 2 as const,
    artifact_kind: "topic_probe_followup_run_receipt" as const,
    relation: "topic_probe_confirmatory" as const,
    parent_run_id: randomUUID(),
    parent_research_cycle: 1,
    child_run_id: childRunId,
    candidate_id: "candidate_fixture",
    topic_id: "topic_fixture",
    contract_content_sha256: hashCanonical({ artifact: "contract_fixture" }),
    outcome_content_sha256: hashCanonical({ artifact: "outcome_fixture" }),
    handoff_content_sha256: hashCanonical({ artifact: "handoff_fixture" }),
    review_gate_content_sha256: hashCanonical({ artifact: "gate_fixture" }),
    research_brief_sha256: hashCanonical(brief),
    recommended_followup_mode: "hypothesis_test" as const,
    evidence_stage: "confirmatory" as const,
    execution_role: "confirmatory_once" as const,
    bounded_probe_paper_evidence_allowed: false as const
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
