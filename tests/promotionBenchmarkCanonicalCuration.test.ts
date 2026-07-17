import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PROMOTION_CANONICAL_ARTIFACT_PATHS,
  PROMOTION_CANONICAL_CURATION_RECORD,
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
  const artifacts = [];
  for (const [role, relativePath] of Object.entries(PROMOTION_CANONICAL_ARTIFACT_PATHS)) {
    const artifactPath = path.join(root, relativePath);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, `${role}\n`, "utf8");
    artifacts.push({
      role,
      path: relativePath,
      sha256: sha256(await readFile(artifactPath))
    });
  }
  const record: PromotionCanonicalCurationRecord = {
    schema_version: "1.0",
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
