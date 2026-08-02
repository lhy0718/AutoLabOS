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
  "build-heldout-registry.mjs"
);
const BASE_PROTOCOL = path.join(
  ROOT,
  "studies",
  "grader-conform",
  "method",
  "confirmatory-protocol.v1.json"
);

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, message: string): string {
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "--quiet", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

type FixtureOptions = {
  scaleShortfall?: boolean;
  duplicatePair?: boolean;
  crossSourceDuplicatePair?: boolean;
  sharedObjectAliases?: boolean;
  duplicateRemoteIdentity?: boolean;
  missingRemoteIdentity?: boolean;
  missingPinnedHead?: boolean;
};

function fixtureRemoteUrl(sourceIndex: number): string {
  return `https://github.com/autolabos-fixtures/source-${sourceIndex + 1}.git`;
}

function configureFixtureRepository(repository: string): void {
  git(repository, ["config", "user.email", "fixture@example.invalid"]);
  git(repository, ["config", "user.name", "Fixture Author"]);
}

function createFixture(options: FixtureOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "heldout-registry-builder-"));
  const repoRoot = path.join(root, "repos");
  const evidenceRoot = path.join(root, "evidence");
  fs.mkdirSync(repoRoot);
  fs.mkdirSync(evidenceRoot);
  const frozenSources: Array<Record<string, unknown>> = [];
  const sourcePlan: Array<Record<string, unknown>> = [];
  const candidates: Array<Record<string, any>> = [];
  const repositories: string[] = [];
  let sharedSeed: string | undefined;
  if (options.sharedObjectAliases) {
    sharedSeed = path.join(root, "shared-seed");
    fs.mkdirSync(sharedSeed);
    git(sharedSeed, ["init", "--quiet"]);
    configureFixtureRepository(sharedSeed);
    fs.writeFileSync(path.join(sharedSeed, "LICENSE"), "Fixture MIT license\n", "utf8");
    fs.writeFileSync(path.join(sharedSeed, "SPEC.md"), "# Evaluator contract\n", "utf8");
    fs.writeFileSync(path.join(sharedSeed, "evaluator.txt"), "shared seed\n", "utf8");
    commit(sharedSeed, "shared seed");
  }
  for (let sourceIndex = 0; sourceIndex < 6; sourceIndex += 1) {
    const sourceId = `source_${sourceIndex + 1}`;
    const cacheKey = `repo_${sourceIndex + 1}`;
    const repository = path.join(repoRoot, cacheKey);
    if (sharedSeed) {
      git(root, ["clone", "--quiet", "--shared", sharedSeed, repository]);
    } else {
      fs.mkdirSync(repository);
      git(repository, ["init", "--quiet"]);
      fs.writeFileSync(path.join(repository, "LICENSE"), "Fixture MIT license\n", "utf8");
      fs.writeFileSync(path.join(repository, "SPEC.md"), "# Evaluator contract\n", "utf8");
      fs.writeFileSync(path.join(repository, "evaluator.txt"), "initial\n", "utf8");
      configureFixtureRepository(repository);
      commit(repository, "initial source");
    }
    configureFixtureRepository(repository);
    const remoteUrl = options.duplicateRemoteIdentity && sourceIndex === 1
      ? fixtureRemoteUrl(0)
      : fixtureRemoteUrl(sourceIndex);
    if (sharedSeed) {
      git(repository, ["remote", "set-url", "origin", remoteUrl]);
    } else {
      git(repository, ["remote", "add", "origin", remoteUrl]);
    }
    repositories.push(repository);
    for (let localIndex = 0; localIndex < 4; localIndex += 1) {
      fs.writeFileSync(
        path.join(repository, "evaluator.txt"),
        `source ${sourceIndex + 1} parent ${localIndex + 1}\n`,
        "utf8"
      );
      const parentCommit = commit(repository, `parent ${localIndex + 1}`);
      fs.writeFileSync(
        path.join(repository, "evaluator.txt"),
        `source ${sourceIndex + 1} fixed ${localIndex + 1}\n`,
        "utf8"
      );
      const fixCommit = commit(repository, `fix ${localIndex + 1}`);
      candidates.push({
        candidate_id: `${sourceId}_candidate_${localIndex + 1}`,
        source_id: sourceId,
        parent_commit: parentCommit,
        fix_commit: fixCommit,
        root_cause_cluster: `${sourceId}_root_${localIndex + 1}`,
        evaluator_paths: ["evaluator.txt"],
        parent_revision_test_paths: [],
        parent_revision_public_contract_paths: ["SPEC.md"],
        license_evidence: { path: "LICENSE" },
      });
    }
    const frozenSource: Record<string, unknown> = {
      source_id: sourceId,
      pinned_head: git(repository, ["rev-parse", "HEAD"]),
      license: "MIT",
      selection_origin: "fixture",
      independence_cluster: `cluster_${sourceIndex + 1}`,
    };
    if (!(options.missingRemoteIdentity && sourceIndex === 0)) {
      frozenSource.remote_url = remoteUrl;
    }
    if (options.missingPinnedHead && sourceIndex === 0) {
      delete frozenSource.pinned_head;
    }
    frozenSources.push(frozenSource);
    sourcePlan.push({
      source_id: sourceId,
      cache_key: cacheKey,
      bounded_environment_notes: [],
    });
  }
  if (options.duplicatePair) {
    candidates[1].parent_commit = candidates[0].parent_commit;
    candidates[1].fix_commit = candidates[0].fix_commit;
  }
  if (options.crossSourceDuplicatePair) {
    const sourcePair = candidates[0];
    const targetCandidate = candidates[4];
    const targetRepository = repositories[1];
    git(targetRepository, [
      "fetch",
      "--quiet",
      "--no-tags",
      repositories[0],
      `${sourcePair.fix_commit}:refs/heads/imported-duplicate-fix`,
    ]);
    git(targetRepository, [
      "merge",
      "--quiet",
      "--no-ff",
      "--no-edit",
      "--allow-unrelated-histories",
      "-s",
      "ours",
      "refs/heads/imported-duplicate-fix",
    ]);
    frozenSources[1].pinned_head = git(targetRepository, ["rev-parse", "HEAD"]);
    targetCandidate.parent_commit = sourcePair.parent_commit;
    targetCandidate.fix_commit = sourcePair.fix_commit;
  }
  const sourceFreezePath = path.join(root, "source-freeze.json");
  writeJson(sourceFreezePath, {
    schema_version: "1.0",
    artifact_type: "heldout_source_selection_freeze",
    status: "frozen_before_heldout_probe_design_or_outcomes",
    active_sources: frozenSources,
    reserve_sources: [],
  });
  const sourceFreezeHash = sha256(fs.readFileSync(sourceFreezePath));
  const sourcePlanPath = path.join(root, "source-plan.json");
  writeJson(sourcePlanPath, {
    schema_version: "1.0",
    artifact_type: "heldout_registry_source_plan",
    frozen_before_probe_design: true,
    method_outcomes_observed: false,
    baseline_outcomes_observed: false,
    activated_reserve_source_ids: [],
    sources: sourcePlan,
  });
  const sourcePlanHash = sha256(fs.readFileSync(sourcePlanPath));
  const protocol = JSON.parse(fs.readFileSync(BASE_PROTOCOL, "utf8"));
  protocol.bindings.find(
    (binding: any) => binding.path === "studies/grader-conform/corpus/heldout-source-freeze.v1.json"
  ).sha256 = sourceFreezeHash;
  protocol.bindings.find(
    (binding: any) => binding.path === "studies/grader-conform/corpus/heldout-registry-source-plan.v1.json"
  ).sha256 = sourcePlanHash;
  const protocolPath = path.join(root, "protocol.json");
  writeJson(protocolPath, protocol);
  const decisions = candidates.map((candidate, index) => ({
    candidate_id: candidate.candidate_id,
    source_id: candidate.source_id,
    decision: options.scaleShortfall && index >= 20 ? "exclude" : "admit",
    reason: "Fixture eligibility decision.",
    root_cause_family: candidate.root_cause_cluster,
    duplicate_of: null,
  }));
  const evidencePath = path.join(evidenceRoot, "group.json");
  writeJson(evidencePath, {
    schema_version: "1.0",
    artifact_type: "sealed_heldout_census_and_adjudication",
    status: "complete",
    exhaustive_within_queries: true,
    group_id: "fixture_group",
    outcome_observed: false,
    method_or_baseline_outcomes_included: false,
    candidates,
    exclusions: [],
    decisions,
  });
  const manifestPath = path.join(evidenceRoot, "manifest.json");
  writeJson(manifestPath, {
    schema_version: "1.0",
    artifact_type: "sealed_heldout_evidence_manifest",
    frozen_before_probe_design: true,
    method_outcomes_observed: false,
    baseline_outcomes_observed: false,
    closed_inventory: true,
    artifacts: [{
      group_id: "fixture_group",
      path: "group.json",
      sha256: sha256(fs.readFileSync(evidencePath)),
      bytes: fs.statSync(evidencePath).size,
    }],
  });
  const outputPath = path.join(root, "registry.json");
  return {
    root,
    outputPath,
    args: [
      BUILDER,
      "--evidence-manifest", manifestPath,
      "--evidence-root", evidenceRoot,
      "--protocol", protocolPath,
      "--source-freeze", sourceFreezePath,
      "--source-plan", sourcePlanPath,
      "--repo-root", repoRoot,
      "--output", outputPath,
    ],
  };
}

describe("heldout registry builder", () => {
  it("derives deterministic lineage order and fixed controls from six Git sources", () => {
    const fixture = createFixture();
    try {
      execFileSync(process.execPath, fixture.args, { cwd: ROOT, encoding: "utf8" });
      const firstRaw = fs.readFileSync(fixture.outputPath, "utf8");
      const registry = JSON.parse(firstRaw);
      expect(registry.lineages).toHaveLength(24);
      expect(registry.fixed_control_lineage_ids).toEqual(
        registry.lineages.map((lineage: any) => lineage.anonymous_lineage_id)
      );
      expect(new Set(registry.lineages.map((lineage: any) => lineage.source_id)).size).toBe(6);
      expect(new Set(registry.sources.map((source: any) => source.public_remote_identity)).size)
        .toBe(6);
      expect(registry.lineages[0]).toMatchObject({
        candidate_id: "source_1_candidate_1",
        anonymous_lineage_id: "heldout_lineage_001",
        registry_index: 0,
      });

      const secondOutput = path.join(fixture.root, "registry-second.json");
      const secondArgs = [...fixture.args];
      secondArgs[secondArgs.indexOf("--output") + 1] = secondOutput;
      execFileSync(process.execPath, secondArgs, { cwd: ROOT, encoding: "utf8" });
      expect(fs.readFileSync(secondOutput, "utf8")).toBe(firstRaw);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 15_000);

  it.each([
    {
      name: "a scale shortfall",
      options: { scaleShortfall: true },
      message: "Heldout scale gate failed",
    },
    {
      name: "a same-source duplicate revision pair",
      options: { duplicatePair: true },
      message: "duplicates an admitted parent/fix revision pair",
    },
    {
      name: "a cross-source duplicate revision pair",
      options: { crossSourceDuplicatePair: true },
      message: "duplicates an admitted parent/fix revision pair",
    },
    {
      name: "shared-clone object-store aliases",
      options: { sharedObjectAliases: true },
      message: "share Git object storage",
    },
    {
      name: "duplicate frozen public remotes",
      options: { duplicateRemoteIdentity: true },
      message: "share frozen public remote identity",
    },
    {
      name: "a missing frozen public remote",
      options: { missingRemoteIdentity: true },
      message: "remote_url must be a frozen public HTTPS Git URL",
    },
    {
      name: "a missing frozen pin",
      options: { missingPinnedHead: true },
      message: "pinned_head must be a full lowercase Git object ID",
    },
  ])("rejects $name", ({ options, message }) => {
    const fixture = createFixture(options);
    try {
      const result = spawnSync(process.execPath, fixture.args, { cwd: ROOT, encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(message);
      expect(fs.existsSync(fixture.outputPath)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
