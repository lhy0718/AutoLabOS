import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const BUILDER = path.join(
  ROOT,
  "studies",
  "grader-conform",
  "scripts",
  "build-v2-adjudication-frame.mjs"
);

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function candidate(candidateId: string, overrides: Record<string, unknown> = {}) {
  return {
    candidate_id: candidateId,
    source_id: "source_one",
    parent_commit: "a".repeat(40),
    fix_commit: "b".repeat(40),
    root_cause_cluster: "evaluation_contract",
    evaluator_paths: ["src/evaluator.ts"],
    parent_revision_public_contract_paths: ["docs/contract.md"],
    parent_revision_test_paths: ["tests/evaluator.test.ts"],
    inclusion_evidence: {
      score_or_verdict_impact: "Historical evaluator behavior can change.",
    },
    license_evidence: { status: "compatible" },
    duplicate_cluster_evidence: { canonical: true },
    ...overrides,
  };
}

function createFixture(options: {
  duplicateCandidate?: boolean;
  candidateOverrides?: Record<string, unknown>;
  expectedCandidateCount?: number;
  extraInventory?: boolean;
  driftManifestHash?: boolean;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grader-conform-v2-frame-"));
  const evidenceRoot = path.join(root, "evidence");
  fs.mkdirSync(evidenceRoot);
  const groupPath = path.join(evidenceRoot, "heldout_group_01.json");
  const candidates = [
    candidate("candidate_one", options.candidateOverrides),
    candidate(options.duplicateCandidate ? "candidate_one" : "candidate_two"),
  ];
  const accounting = {
    census_candidate_count: candidates.length,
    admitted_candidate_count: 1,
    excluded_candidate_count: 1,
    search_exclusion_count: 3,
    every_candidate_adjudicated_exactly_once: true,
  };
  writeJson(groupPath, {
    schema_version: "1.0",
    artifact_type: "sealed_heldout_census_and_adjudication",
    status: "complete",
    exhaustive_within_queries: true,
    group_id: "heldout_group_01",
    outcome_observed: false,
    method_or_baseline_outcomes_included: false,
    candidate_accounting: accounting,
    candidates,
    decisions: candidates.map((item, index) => ({
      candidate_id: item.candidate_id,
      decision: index === 0 ? "admit" : "exclude",
    })),
  });
  const groupRaw = fs.readFileSync(groupPath);
  const manifestPath = path.join(evidenceRoot, "manifest.json");
  writeJson(manifestPath, {
    schema_version: "1.0",
    artifact_type: "sealed_heldout_evidence_manifest",
    seal_plan_sha256: "c".repeat(64),
    frozen_before_probe_design: true,
    method_outcomes_observed: false,
    baseline_outcomes_observed: false,
    closed_inventory: true,
    artifacts: [{
      group_id: "heldout_group_01",
      path: "heldout_group_01.json",
      sha256: options.driftManifestHash ? "d".repeat(64) : sha256(groupRaw),
      bytes: groupRaw.length,
      candidate_accounting: accounting,
    }],
  });
  if (options.extraInventory) {
    fs.writeFileSync(path.join(evidenceRoot, "unbound.json"), "{}\n", "utf8");
  }
  const outputRoot = path.join(root, "frame-bundle");
  return {
    root,
    outputRoot,
    args: [
      BUILDER,
      "--evidence-manifest", manifestPath,
      "--evidence-root", evidenceRoot,
      "--expected-candidate-count", String(options.expectedCandidateCount ?? 2),
      "--output-root", outputRoot,
    ],
  };
}

describe("v2 outcome-blind adjudication frame", () => {
  it("projects every retained candidate without prior v1 dispositions", () => {
    const fixture = createFixture();
    try {
      execFileSync(process.execPath, fixture.args, { cwd: ROOT, encoding: "utf8" });
      const controllerRaw = fs.readFileSync(
        path.join(fixture.outputRoot, "controller-frame.json"),
        "utf8"
      );
      const reviewerRaw = fs.readFileSync(
        path.join(fixture.outputRoot, "reviewer-frame.json"),
        "utf8"
      );
      const frame = JSON.parse(controllerRaw);
      const reviewer = JSON.parse(reviewerRaw);

      expect(frame.frame_contract).toMatchObject({
        expected_candidate_count: 2,
        observed_candidate_count: 2,
        direct_eligibility_adjudicator_input_allowed: false,
        prior_v1_adjudication_dispositions_included: false,
        prior_v1_admission_count_used_as_denominator: false,
        relation_or_template_applicability_used_for_eligibility: false,
      });
      expect(frame.candidates.map((item: { candidate_id: string }) => item.candidate_id))
        .toEqual(["candidate_one", "candidate_two"]);
      expect(controllerRaw).not.toContain('"decision"');
      expect(controllerRaw).not.toContain('"admitted_candidate_count"');
      expect(controllerRaw).not.toContain('"excluded_candidate_count"');
      expect(reviewer.review_contract).toMatchObject({
        original_candidate_identifiers_included: false,
        prior_inclusion_reasons_included: false,
        prior_fault_family_or_root_cause_labels_included: false,
      });
      expect(reviewer.candidates).toHaveLength(2);
      expect(reviewer.candidates[0].opaque_candidate_id).toMatch(/^v2cand_[a-f0-9]{20}$/u);
      expect(reviewerRaw).not.toContain("candidate_one");
      expect(reviewerRaw).not.toContain("root_cause_cluster");
      expect(reviewerRaw).not.toContain("inclusion_evidence");
      expect(fs.readdirSync(fixture.outputRoot).sort()).toEqual([
        "controller-frame.json",
        "manifest.json",
        "reviewer-frame.json",
      ]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("is byte-deterministic for the same sealed evidence", () => {
    const fixture = createFixture();
    const secondOutputRoot = path.join(fixture.root, "frame-bundle-second");
    try {
      execFileSync(process.execPath, fixture.args, { cwd: ROOT, encoding: "utf8" });
      const secondArgs = [...fixture.args];
      secondArgs[secondArgs.length - 1] = secondOutputRoot;
      execFileSync(process.execPath, secondArgs, { cwd: ROOT, encoding: "utf8" });
      for (const filename of ["controller-frame.json", "reviewer-frame.json", "manifest.json"]) {
        expect(fs.readFileSync(path.join(secondOutputRoot, filename))).toEqual(
          fs.readFileSync(path.join(fixture.outputRoot, filename))
        );
      }
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    [
      { candidateOverrides: { decision: "admit" } },
      "unknown field decision",
    ],
    [
      { candidateOverrides: { inclusion_evidence: { relation_applicability: "applicable" } } },
      "Forbidden prior decision or study outcome field",
    ],
    [
      { duplicateCandidate: true },
      "Duplicate candidate_id",
    ],
    [
      { expectedCandidateCount: 3 },
      "Expected 3 retained candidates but observed 2",
    ],
    [
      { extraInventory: true },
      "inventory differs from the closed manifest",
    ],
    [
      { driftManifestHash: true },
      "bytes drifted from the sealed manifest",
    ],
  ])("fails closed on frame-integrity attack %#", (options, message) => {
    const fixture = createFixture(options);
    try {
      const result = spawnSync(process.execPath, fixture.args, { cwd: ROOT, encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(message);
      expect(fs.existsSync(fixture.outputRoot)).toBe(false);
      expect(
        fs.readdirSync(fixture.root).filter((entry) => entry.startsWith("frame-bundle.staging-"))
      ).toEqual([]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
