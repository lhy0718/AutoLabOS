import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runPaperReadinessAudit } from "../src/core/audit/paperReadinessAudit.js";
import {
  PROMOTION_CANONICAL_ARTIFACT_PATHS,
  PROMOTION_CANONICAL_CURATION_RECORD,
  PROMOTION_CANONICAL_CURATION_SCHEMA_VERSION,
  inspectPromotionCanonicalCuration,
  type PromotionCanonicalCurationRecord
} from "../src/core/benchmark/promotionBenchmarkCanonicalCuration.js";
import type {
  PromotionTrialCandidateRecord
} from "../src/core/benchmark/promotionBenchmarkTrialCandidateHandoff.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("promotion benchmark canonical curation", () => {
  it("verifies a human-curated clean control against all paired traces and artifacts", async () => {
    const fixture = await writeCuratedFixture();

    const inspection = await inspectPromotionCanonicalCuration({
      sourceRoot: fixture.root,
      handoffId: fixture.handoffId,
      sourceRevision: fixture.sourceRevision,
      candidate: fixture.candidate
    });

    expect(inspection).toMatchObject({
      passed: true,
      verified_artifact_count: Object.keys(PROMOTION_CANONICAL_ARTIFACT_PATHS).length,
      issues: []
    });
    expect(inspection.record_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps a semantically valid canonical clean control promotable by the independent artifact audit", async () => {
    const fixture = await writeCuratedFixture();

    const summary = await runPaperReadinessAudit({
      cwd: fixture.root,
      runRoot: fixture.root,
      outDir: path.join(fixture.root, "audit-output")
    });

    expect(summary.verdict).toBe("conditionally-ready");
    expect(summary.paper_readiness.paper_ready).toBe(true);
    expect(summary.top_blockers).toEqual([]);
  });

  it("fails closed on artifact, source-trace, and human-role tampering", async () => {
    const fixture = await writeCuratedFixture();
    await writeFile(path.join(fixture.root, PROMOTION_CANONICAL_ARTIFACT_PATHS.result_table), "changed\n", "utf8");

    const artifactTampered = await inspectPromotionCanonicalCuration({
      sourceRoot: fixture.root,
      handoffId: fixture.handoffId,
      sourceRevision: fixture.sourceRevision,
      candidate: fixture.candidate
    });
    expect(artifactTampered.passed).toBe(false);
    expect(artifactTampered.issues.map((issue) => issue.code)).toContain(
      "canonical_curation_artifact_hash_mismatch"
    );

    const recordPath = path.join(fixture.root, PROMOTION_CANONICAL_CURATION_RECORD);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as PromotionCanonicalCurationRecord;
    record.verifier_id = record.curator_id;
    record.source_trials[0].source_blob_sha256 = sha256("different-source");
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    const provenanceTampered = await inspectPromotionCanonicalCuration({
      sourceRoot: fixture.root,
      handoffId: fixture.handoffId,
      sourceRevision: fixture.sourceRevision,
      candidate: fixture.candidate
    });
    expect(provenanceTampered.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "canonical_curation_human_roles_not_independent",
      "canonical_curation_source_trace_mismatch"
    ]));
  });

  it("rejects hash-matched but semantically inconsistent clean-control artifacts", async () => {
    const fixture = await writeCuratedFixture();
    const resultPath = path.join(fixture.root, PROMOTION_CANONICAL_ARTIFACT_PATHS.result_table);
    await writeJsonFile(resultPath, [{
      metric: "primary_metric",
      baseline: 0.4,
      comparator: 0.5,
      delta: 0.9,
      direction: "higher_better"
    }]);
    const recordPath = path.join(fixture.root, PROMOTION_CANONICAL_CURATION_RECORD);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as PromotionCanonicalCurationRecord;
    const resultBinding = record.artifacts.find((artifact) => artifact.role === "result_table");
    if (!resultBinding) throw new Error("missing result binding");
    resultBinding.sha256 = sha256(await readFile(resultPath));
    await writeJsonFile(recordPath, record);

    const inspection = await inspectPromotionCanonicalCuration({
      sourceRoot: fixture.root,
      handoffId: fixture.handoffId,
      sourceRevision: fixture.sourceRevision,
      candidate: fixture.candidate
    });

    expect(inspection.passed).toBe(false);
    expect(inspection.issues.map((issue) => issue.code)).toContain(
      "canonical_curation_result_table_invalid"
    );
    expect(inspection.issues.map((issue) => issue.code)).not.toContain(
      "canonical_curation_artifact_hash_mismatch"
    );
  });

  it("rejects hash-matched cross-artifact trial, claim, and readiness drift", async () => {
    const fixture = await writeCuratedFixture();
    await writeJsonFile(path.join(fixture.root, "experiment_evidence.json"), {
      trials: [{ trial_id: fixture.candidate.trials[0].trial_id }]
    });
    await writeJsonFile(path.join(fixture.root, "run_config.json"), {
      planned_budget: { trials: 1 }
    });
    await writeJsonFile(path.join(fixture.root, "run_record.json"), {
      id: "run-clean-control",
      status: "failed",
      executed_budget: { trials: 1 }
    });
    await writeJsonFile(path.join(fixture.root, "figure_audit", "figure_audit_summary.json"), {
      audited_at: "invalid",
      figure_count: 0,
      issues: ["mismatch"],
      severe_mismatch_count: 1,
      review_block_required: true
    });
    await writeJsonFile(path.join(fixture.root, "paper", "claim_status_table.json"), {
      claims: [{ claim_id: "claim-primary", status: "blocked", artifact_refs: [], citation_refs: [] }]
    });
    await writeJsonFile(path.join(fixture.root, "paper", "claim_evidence_table.json"), {
      claims: [{ claim_id: "claim-other", artifact_refs: [], citation_refs: [] }]
    });
    await writeJsonFile(path.join(fixture.root, "paper", "evidence_links.json"), {
      claims: [{ claim_id: "claim-primary", evidence_ids: ["evidence-missing"], citation_paper_ids: [] }]
    });
    await writeFile(
      path.join(fixture.root, "evidence_store.jsonl"),
      `${JSON.stringify({ id: "evidence-other", metric_evidence_present: true })}\n`,
      "utf8"
    );
    await writeJsonFile(path.join(fixture.root, "checkpoint", "state.json"), {
      paper_ready: false,
      run_status: "failed"
    });
    await writeJsonFile(path.join(fixture.root, "paper", "paper_readiness.json"), {
      paper_ready: false,
      readiness_state: "blocked"
    });
    await writeJsonFile(path.join(fixture.root, "review", "decision.json"), { outcome: "block" });
    await writeJsonFile(path.join(fixture.root, "design_contracts.json"), {
      sota_ranking_claimed: true,
      sota_evidence_present: false
    });
    await writeFile(path.join(fixture.root, "paper", "main.tex"), "TODO placeholder\n", "utf8");

    const recordPath = path.join(fixture.root, PROMOTION_CANONICAL_CURATION_RECORD);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as PromotionCanonicalCurationRecord;
    record.curated_at = "2026-01-04T00:00:00.000Z";
    for (const artifact of record.artifacts) {
      artifact.sha256 = sha256(await readFile(path.join(fixture.root, artifact.path)));
    }
    await writeJsonFile(recordPath, record);

    const inspection = await inspectPromotionCanonicalCuration({
      sourceRoot: fixture.root,
      handoffId: fixture.handoffId,
      sourceRevision: fixture.sourceRevision,
      candidate: fixture.candidate
    });
    expect(inspection.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "canonical_curation_trial_evidence_invalid",
      "canonical_curation_run_contract_invalid",
      "canonical_curation_figure_audit_invalid",
      "canonical_curation_claim_evidence_invalid",
      "canonical_curation_evidence_store_invalid",
      "canonical_curation_readiness_inconsistent",
      "canonical_curation_design_contract_invalid",
      "canonical_curation_paper_artifact_invalid",
      "canonical_curation_timestamp_order_invalid"
    ]));
    expect(inspection.issues.map((issue) => issue.code)).not.toContain(
      "canonical_curation_artifact_hash_mismatch"
    );
  });

  it("rejects a required artifact reached through a parent-directory symlink", async () => {
    const fixture = await writeCuratedFixture();
    const external = await mkdtemp(path.join(os.tmpdir(), "promotion-canonical-external-"));
    tempDirs.push(external);
    const relativePath = PROMOTION_CANONICAL_ARTIFACT_PATHS.figure_audit;
    const original = await readFile(path.join(fixture.root, relativePath));
    await rm(path.join(fixture.root, "figure_audit"), { recursive: true, force: true });
    await writeFile(path.join(external, "figure_audit_summary.json"), original);
    await symlink(external, path.join(fixture.root, "figure_audit"), "dir");

    const inspection = await inspectPromotionCanonicalCuration({
      sourceRoot: fixture.root,
      handoffId: fixture.handoffId,
      sourceRevision: fixture.sourceRevision,
      candidate: fixture.candidate
    });
    expect(inspection.passed).toBe(false);
    expect(inspection.issues.map((issue) => issue.code)).toContain(
      "canonical_curation_artifact_path_unsafe"
    );
  });
});

async function writeCuratedFixture(): Promise<{
  root: string;
  handoffId: string;
  sourceRevision: string;
  candidate: PromotionTrialCandidateRecord;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "promotion-canonical-curation-"));
  tempDirs.push(root);
  const handoffId = "candidate-handoff";
  const sourceRevision = "source-revision";
  const candidate = candidateFixture();
  await writeCanonicalArtifacts(root, candidate);
  const artifacts = [];
  for (const [role, relativePath] of Object.entries(PROMOTION_CANONICAL_ARTIFACT_PATHS)) {
    const artifactPath = path.join(root, relativePath);
    artifacts.push({
      role,
      path: relativePath,
      sha256: sha256(await readFile(artifactPath))
    });
  }
  const record: PromotionCanonicalCurationRecord = {
    schema_version: PROMOTION_CANONICAL_CURATION_SCHEMA_VERSION,
    provenance_class: "benchmark_curated",
    handoff_id: handoffId,
    candidate_id: candidate.candidate_id,
    source_revision: sourceRevision,
    base_candidate_sha256: candidate.base_candidate_sha256,
    curation_status: "human_verified",
    curator_id: "curator-a",
    verifier_id: "verifier-b",
    curated_at: "2026-01-01T00:00:00.000Z",
    verified_at: "2026-01-02T00:00:00.000Z",
    curator_protocol_version: "curation-protocol-1",
    verifier_protocol_version: "verification-protocol-1",
    derivation_mode: "deterministic",
    intended_readiness: "promote",
    evidence_ceiling: "paper_scale_candidate",
    source_trials: [
      ...candidate.trials.map((trial) => ({
        group_id: "group-a" as const,
        trial_id: trial.trial_id,
        source_ref_sha256: trial.source_ref_sha256,
        source_blob_sha256: trial.source_blob_sha256,
        reviewer_blob_sha256: trial.reviewer_blob_sha256
      })),
      ...(candidate.comparator_trials || []).map((trial) => ({
        group_id: "group-b" as const,
        trial_id: trial.trial_id,
        source_ref_sha256: trial.source_ref_sha256,
        source_blob_sha256: trial.source_blob_sha256,
        reviewer_blob_sha256: trial.reviewer_blob_sha256
      }))
    ],
    artifacts: artifacts as PromotionCanonicalCurationRecord["artifacts"],
    evidence_boundary: "Curated controls bind reviewed source traces and benchmark-owned artifacts."
  };
  await writeFile(
    path.join(root, PROMOTION_CANONICAL_CURATION_RECORD),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8"
  );
  return { root, handoffId, sourceRevision, candidate };
}

async function writeCanonicalArtifacts(
  root: string,
  candidate: PromotionTrialCandidateRecord
): Promise<void> {
  const trialIds = [
    ...candidate.trials,
    ...(candidate.comparator_trials || [])
  ].map((trial) => trial.trial_id);
  await writeJsonFile(path.join(root, "result_table.json"), [{
    metric: "primary_metric",
    baseline: 0.4,
    comparator: 0.5,
    delta: 0.1,
    direction: "higher_better"
  }]);
  await writeJsonFile(path.join(root, "experiment_evidence.json"), {
    trials: trialIds.map((trialId) => ({ trial_id: trialId }))
  });
  await writeJsonFile(path.join(root, "run_config.json"), {
    planned_budget: { trials: trialIds.length }
  });
  await writeJsonFile(path.join(root, "run_record.json"), {
    id: "run-clean-control",
    status: "completed",
    executed_budget: { trials: trialIds.length }
  });
  await mkdir(path.join(root, "figure_audit"), { recursive: true });
  await mkdir(path.join(root, "review"), { recursive: true });
  await mkdir(path.join(root, "paper"), { recursive: true });
  await mkdir(path.join(root, "checkpoint"), { recursive: true });
  await writeFile(
    path.join(root, "evidence_store.jsonl"),
    `${JSON.stringify({ id: "evidence-primary", metric_evidence_present: true })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(root, "research_brief.md"),
    "# Research Brief\n\n## Paper-worthiness Gate\n\nPaper-ready promotion requires the complete governed artifact contract.\n",
    "utf8"
  );
  await writeJsonFile(path.join(root, "design_contracts.json"), {
    sota_ranking_claimed: false,
    sota_evidence_present: false
  });
  await writeJsonFile(path.join(root, "figure_audit", "figure_audit_summary.json"), {
    audited_at: "2026-01-01T00:00:00.000Z",
    figure_count: 1,
    issues: [],
    severe_mismatch_count: 0,
    review_block_required: false
  });
  await writeJsonFile(path.join(root, "review", "paper_critique.json"), {
    paper_readiness_state: "paper_ready",
    claim_ceiling_applied: true
  });
  await writeJsonFile(path.join(root, "review", "decision.json"), { outcome: "accept" });
  await writeFile(
    path.join(root, "paper", "main.tex"),
    "\\section{Results}\nThe measured comparison is linked to the canonical evidence artifacts.\n",
    "utf8"
  );
  await writeJsonFile(path.join(root, "paper", "paper_readiness.json"), {
    paper_ready: true,
    readiness_state: "paper_ready"
  });
  const claim = {
    claim_id: "claim-primary",
    statement: "The measured comparison is reported.",
    section_heading: "Results",
    status: "verified",
    artifact_refs: ["result_table.json"],
    citation_refs: ["source-primary"],
    reproduction_trace_present: true
  };
  await writeJsonFile(path.join(root, "paper", "claim_status_table.json"), { claims: [claim] });
  await writeJsonFile(path.join(root, "paper", "claim_evidence_table.json"), {
    claims: [{
      ...claim,
      strength: "measured"
    }]
  });
  await writeJsonFile(path.join(root, "paper", "evidence_links.json"), {
    claims: [{
      claim_id: claim.claim_id,
      evidence_ids: ["evidence-primary"],
      citation_paper_ids: ["source-primary"]
    }]
  });
  await writeJsonFile(path.join(root, "checkpoint", "state.json"), {
    paper_ready: true,
    run_status: "completed"
  });
}

async function writeJsonFile(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function candidateFixture(): PromotionTrialCandidateRecord {
  const trials = (group: string) => [0, 1, 2].map((ordinal) => ({
    trial_id: `${group}-trial-${ordinal}`,
    source_ref_sha256: sha256(`${group}-ref-${ordinal}`),
    source_blob_sha256: sha256(`${group}-source-${ordinal}`),
    reviewer_blob_sha256: sha256(`${group}-reviewer-${ordinal}`),
    privacy_redaction_count: 0,
    artifact_path: `artifacts/${group}-trial-${ordinal}/trace.json`
  }));
  return {
    candidate_id: "candidate-a",
    base_candidate_sha256: sha256("candidate-base"),
    source_family_id_sha256: sha256("source-family"),
    operator_group_id_sha256: sha256("operator-primary"),
    trials: trials("primary"),
    comparator_operator_group_id_sha256: sha256("operator-comparator"),
    comparator_trials: trials("comparator")
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
