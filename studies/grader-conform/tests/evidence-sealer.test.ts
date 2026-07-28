import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SEALER = path.join(
  ROOT,
  "studies",
  "grader-conform",
  "scripts",
  "seal-heldout-evidence.mjs"
);

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

type OutcomeLeakLocation =
  | "census_candidate"
  | "census_exclusion"
  | "census_metadata"
  | "adjudication_decision"
  | "adjudication_details"
  | "adjudicator_outcomes_inspected"
  | "nested_outcome_observed";

function createFixture(options: {
  missingDecision?: boolean;
  missingOutcomeBoundary?: boolean;
  candidatePathLeak?: boolean;
  invalidDuplicate?: boolean;
  outcomeLeakLocation?: OutcomeLeakLocation;
  groupId?: string;
  conflictingGroupId?: string;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heldout-evidence-sealer-"));
  const inputRoot = path.join(root, "inputs");
  const outputRoot = path.join(root, "sealed");
  fs.mkdirSync(inputRoot);
  const censusPath = path.join(inputRoot, "census.json");
  const adjudicationPath = path.join(inputRoot, "adjudication.json");
  const planPath = path.join(root, "plan.json");
  const candidates: Array<Record<string, unknown>> = [
    {
      candidate_id: "candidate_one",
      source_id: "source_one",
      root_cause_cluster: "parser_contract",
      evidence: options.candidatePathLeak ? "/home/private/evidence.json" : "src/evaluator.ts",
      inclusion_evidence: {
        score_or_verdict_impact: "Equivalent answers can change from mismatch to match.",
        false_positive_class: "Historical evaluator defect, not a study detection outcome.",
      },
    },
    {
      candidate_id: "candidate_two",
      source_id: "source_one",
      root_cause_cluster: "replay_contract",
      evidence: "src/replay.ts",
    },
  ];
  const exclusions: Array<Record<string, unknown>> = [{
    exclusion_id: "search_hit_one",
    exclusion_reason: "Public documentation discusses detection outcomes but reports no experiment result.",
  }];
  const census: Record<string, unknown> = {
    schema_version: "1.0",
    status: "complete",
    exhaustive_within_queries: true,
    outcome_observed: false,
    sources: [{
      source_id: "source_one",
      path: "/tmp/private/source-one",
      history: { mirror_path: "/tmp/private/source-one.git" },
      remote: "https://example.invalid/source-one.git",
      detection_method: "Reports whether a public object is detected by the parser.",
      method_metadata: { version: 1, enabled: true },
      probe_count: 3,
    }],
    collection_notes: "The public API uses the ordinary words outcome, detection, baseline, and probe.",
    candidates,
    exclusions,
  };
  if (options.outcomeLeakLocation === "census_candidate") {
    candidates[0].audit = { method_outcome: "detected" };
  } else if (options.outcomeLeakLocation === "census_exclusion") {
    exclusions[0].screening = { baseline_detection_result: "not_detected" };
  } else if (options.outcomeLeakLocation === "census_metadata") {
    census.collection_state = { probe: { status: "detected" } };
  }
  writeJson(censusPath, census);
  const decisions: Array<Record<string, unknown>> = [
    {
      candidate_id: "candidate_one",
      decision: "admit",
      reason: "The deterministic evaluator expects the public runtime path /tmp/poc.",
      root_cause_family: "parser_contract",
      duplicate_of: null,
    },
    ...(!options.missingDecision ? [{
      candidate_id: "candidate_two",
      decision: "exclude",
      reason: "Generic application behavior.",
      root_cause_family: "application_behavior",
      duplicate_of: options.invalidDuplicate ? "missing_candidate" : null,
    }] : []),
  ];
  const adjudication: Record<string, unknown> = {
    schema_version: "1.0",
    artifact_type: "independent_heldout_adjudication",
    status: "complete",
    outcome_observed: false,
    adjudicator_blindness: {
      probe_method_baseline_outcomes_inspected: false,
    },
    review_notes: "Detection method terminology here describes the public domain, not a study outcome.",
    decisions,
  };
  if (options.outcomeLeakLocation === "adjudication_decision") {
    decisions[0].analysis = { baseline_outcome: "missed" };
  } else if (options.outcomeLeakLocation === "adjudication_details") {
    adjudication.review_details = { probe_detection_result: "detected" };
  } else if (options.outcomeLeakLocation === "adjudicator_outcomes_inspected") {
    (adjudication.adjudicator_blindness as Record<string, unknown>)
      .probe_method_baseline_outcomes_inspected = true;
  } else if (options.outcomeLeakLocation === "nested_outcome_observed") {
    adjudication.review_details = { outcome_observed: true };
  }
  if (options.missingOutcomeBoundary) delete adjudication.outcome_observed;
  writeJson(adjudicationPath, adjudication);
  const group = {
    group_id: options.groupId ?? "group_one",
    census: {
      path: "census.json",
      sha256: sha256(fs.readFileSync(censusPath)),
    },
    adjudications: [{
      path: "adjudication.json",
      sha256: sha256(fs.readFileSync(adjudicationPath)),
    }],
  };
  writeJson(planPath, {
    schema_version: "1.0",
    artifact_type: "heldout_evidence_seal_plan",
    frozen_before_probe_design: true,
    method_outcomes_observed: false,
    baseline_outcomes_observed: false,
    groups: [
      group,
      ...(options.conflictingGroupId ? [{ ...group, group_id: options.conflictingGroupId }] : []),
    ],
  });
  return {
    root,
    outputRoot,
    args: [
      SEALER,
      "--plan", planPath,
      "--input-root", inputRoot,
      "--output-root", outputRoot,
    ],
  };
}

describe("heldout evidence sealer", () => {
  it("hash-binds complete decisions and strips source-cache paths", () => {
    const fixture = createFixture();
    try {
      fs.mkdirSync(fixture.outputRoot);
      execFileSync(process.execPath, fixture.args, { cwd: ROOT, encoding: "utf8" });
      const sealedPath = path.join(fixture.outputRoot, "group_one.json");
      const manifestPath = path.join(fixture.outputRoot, "manifest.json");
      const sealedRaw = fs.readFileSync(sealedPath, "utf8");
      const sealed = JSON.parse(sealedRaw);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

      expect(sealed.candidate_accounting).toEqual({
        census_candidate_count: 2,
        admitted_candidate_count: 1,
        excluded_candidate_count: 1,
        search_exclusion_count: 1,
        every_candidate_adjudicated_exactly_once: true,
      });
      expect(sealed.census_metadata.sources[0]).not.toHaveProperty("path");
      expect(sealed.census_metadata.sources[0].history).not.toHaveProperty("mirror_path");
      expect(sealed.candidates[0].inclusion_evidence).toEqual({
        score_or_verdict_impact: "Equivalent answers can change from mismatch to match.",
        false_positive_class: "Historical evaluator defect, not a study detection outcome.",
      });
      expect(sealed.decisions[0].reason).toContain("/tmp/poc");
      expect(sealedRaw).not.toContain("/tmp/private");
      expect(manifest.artifacts).toHaveLength(1);
      expect(manifest.artifacts[0].sha256).toBe(sha256(fs.readFileSync(sealedPath)));
      expect(fs.readdirSync(fixture.outputRoot).sort()).toEqual(["group_one.json", "manifest.json"]);
      expect(fs.readdirSync(fixture.root).filter((entry) => entry.startsWith("sealed.staging-"))).toEqual([]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    [{ missingDecision: true }, "missing exactly-one adjudication"],
    [{ missingOutcomeBoundary: true }, "lacks a complete pre-outcome contract"],
    [{ candidatePathLeak: true }, "Machine-local absolute path remains"],
    [{ invalidDuplicate: true }, "duplicates an unknown candidate"],
  ])("rejects incomplete or non-portable evidence without partial output", (options, message) => {
    const fixture = createFixture(options);
    try {
      const result = spawnSync(process.execPath, fixture.args, { cwd: ROOT, encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(message);
      expect(fs.existsSync(fixture.outputRoot)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each<OutcomeLeakLocation>([
    "census_candidate",
    "census_exclusion",
    "census_metadata",
    "adjudication_decision",
    "adjudication_details",
    "adjudicator_outcomes_inspected",
    "nested_outcome_observed",
  ])("rejects hidden %s result data without publishing output", (outcomeLeakLocation) => {
    const fixture = createFixture({ outcomeLeakLocation });
    try {
      const result = spawnSync(process.execPath, fixture.args, { cwd: ROOT, encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("forbidden method/baseline/probe outcome field");
      expect(fs.existsSync(fixture.outputRoot)).toBe(false);
      expect(fs.readdirSync(fixture.root).filter((entry) => entry.startsWith("sealed.staging-"))).toEqual([]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    [{ groupId: "manifest" }, "reserved output manifest.json"],
    [
      { groupId: "group_one", conflictingGroupId: "GROUP_ONE" },
      "output filename collision",
    ],
  ])("rejects reserved or colliding output names before publication", (options, message) => {
    const fixture = createFixture(options);
    try {
      const result = spawnSync(process.execPath, fixture.args, { cwd: ROOT, encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(message);
      expect(fs.existsSync(fixture.outputRoot)).toBe(false);
      expect(fs.readdirSync(fixture.root).filter((entry) => entry.startsWith("sealed.staging-"))).toEqual([]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("leaves an existing non-empty output target untouched on failure", () => {
    const fixture = createFixture();
    const markerPath = path.join(fixture.outputRoot, "existing.txt");
    try {
      fs.mkdirSync(fixture.outputRoot);
      fs.writeFileSync(markerPath, "keep\n", "utf8");
      const result = spawnSync(process.execPath, fixture.args, { cwd: ROOT, encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Output root must be empty before sealing");
      expect(fs.readFileSync(markerPath, "utf8")).toBe("keep\n");
      expect(fs.readdirSync(fixture.outputRoot)).toEqual(["existing.txt"]);
      expect(fs.readdirSync(fixture.root).filter((entry) => entry.startsWith("sealed.staging-"))).toEqual([]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("removes staged files after a publication write failure", () => {
    const fixture = createFixture({ groupId: "x".repeat(300) });
    try {
      const result = spawnSync(process.execPath, fixture.args, { cwd: ROOT, encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(fs.existsSync(fixture.outputRoot)).toBe(false);
      expect(fs.readdirSync(fixture.root).filter((entry) => entry.startsWith("sealed.staging-"))).toEqual([]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
