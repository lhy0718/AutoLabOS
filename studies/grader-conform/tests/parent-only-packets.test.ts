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
  "build-parent-only-packets.mjs"
);
const BASE_PROTOCOL = path.join(
  ROOT,
  "studies",
  "grader-conform",
  "method",
  "confirmatory-protocol.v1.json"
);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createFixture(): {
  root: string;
  registryPath: string;
  outputPath: string;
  snapshotRoot: string;
  parentCommit: string;
  fixCommit: string;
  args: string[];
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "parent-only-packets-"));
  const repoRoot = path.join(root, "cache");
  const evidenceRoot = path.join(root, "evidence");
  const repository = path.join(repoRoot, "fixture-source");
  fs.mkdirSync(repository, { recursive: true });
  fs.mkdirSync(evidenceRoot, { recursive: true });
  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.email", "fixture@example.invalid"]);
  git(repository, ["config", "user.name", "Fixture Author"]);
  fs.writeFileSync(path.join(repository, "evaluator.py"), "def grade(value):\n    return value\n", "utf8");
  fs.writeFileSync(path.join(repository, "test_evaluator.py"), "assert True\n", "utf8");
  fs.writeFileSync(path.join(repository, "SPEC.md"), "# Public contract\n", "utf8");
  const licenseText = "Fixture permissive license\n";
  fs.writeFileSync(path.join(repository, "LICENSE"), licenseText, "utf8");
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "parent"]);
  const parentCommit = git(repository, ["rev-parse", "HEAD"]);
  const parentTree = git(repository, ["rev-parse", `${parentCommit}^{tree}`]);
  fs.writeFileSync(path.join(repository, "evaluator.py"), "def grade(value):\n    return bool(value)\n", "utf8");
  git(repository, ["commit", "--quiet", "-am", "repair evaluator"]);
  const fixCommit = git(repository, ["rev-parse", "HEAD"]);
  const registryPath = path.join(root, "registry.json");
  const outputPath = path.join(root, "packets.json");
  const snapshotRoot = path.join(root, "snapshots");
  const sourceFreezePath = path.join(root, "source-freeze.json");
  writeJson(sourceFreezePath, {
    schema_version: "1.0",
    artifact_type: "heldout_source_selection_freeze",
    status: "frozen_before_heldout_probe_design_or_outcomes",
    active_sources: [{
      source_id: "fixture_source",
      pinned_head: fixCommit,
      independence_cluster: "fixture_cluster",
    }],
    reserve_sources: [],
  });
  const sourceFreezeHash = sha256(fs.readFileSync(sourceFreezePath, "utf8"));
  const protocol = JSON.parse(fs.readFileSync(BASE_PROTOCOL, "utf8"));
  const sourceFreezeBinding = protocol.bindings.find(
    (binding: any) => binding.path === "studies/grader-conform/corpus/heldout-source-freeze.v1.json"
  );
  sourceFreezeBinding.sha256 = sourceFreezeHash;
  const protocolPath = path.join(root, "protocol.json");
  writeJson(protocolPath, protocol);
  const protocolHash = sha256(fs.readFileSync(protocolPath, "utf8"));
  const candidateId = "fixture_candidate_001";
  const censusPath = path.join(evidenceRoot, "census.json");
  const adjudicationPath = path.join(evidenceRoot, "adjudication.json");
  writeJson(censusPath, {
    schema_version: "1.0",
    status: "complete",
    exhaustive_within_queries: true,
    outcome_observed: false,
    candidates: [{ candidate_id: candidateId }],
    exclusions: [],
  });
  writeJson(adjudicationPath, {
    schema_version: "1.0",
    status: "complete",
    outcome_observed: false,
    decisions: [{ candidate_id: candidateId, decision: "admit" }],
  });
  writeJson(registryPath, {
    schema_version: "1.0",
    artifact_type: "heldout_lineage_registry",
    protocol_sha256: protocolHash,
    source_freeze_sha256: sourceFreezeHash,
    frozen_before_probe_design: true,
    method_outcomes_observed: false,
    baseline_outcomes_observed: false,
    activated_reserve_source_ids: [],
    census_bindings: [{
      path: "census.json",
      sha256: sha256(fs.readFileSync(censusPath, "utf8")),
    }],
    adjudication_bindings: [{
      path: "adjudication.json",
      sha256: sha256(fs.readFileSync(adjudicationPath, "utf8")),
    }],
    excluded_candidate_ids: [],
    sources: [{
      source_id: "fixture_source",
      blinded_source_id: "blind_source_01",
      pinned_head: fixCommit,
      independence_cluster: "fixture_cluster",
      cache_key: "fixture-source",
      license_evidence: "LICENSE at pinned source revision",
      bounded_environment_notes: ["No network is required."],
    }],
    lineages: [{
      candidate_id: candidateId,
      anonymous_lineage_id: "heldout_fixture_001",
      registry_index: 0,
      source_id: "fixture_source",
      parent_commit: parentCommit,
      fix_commit: fixCommit,
      parent_tree_hash: parentTree,
      parent_license_path: "LICENSE",
      parent_license_sha256: sha256(licenseText),
      parent_revision_evaluator_paths: ["evaluator.py"],
      parent_revision_test_paths: ["test_evaluator.py"],
      parent_revision_public_contract_paths: ["SPEC.md"],
      parent_revision_entrypoints: ["python evaluator.py"],
      bounded_environment_notes: [],
      historical_fault_description: "must remain sealed",
    }],
  });
  return {
    root,
    registryPath,
    outputPath,
    snapshotRoot,
    parentCommit,
    fixCommit,
    args: [
      BUILDER,
      "--registry", registryPath,
      "--protocol", protocolPath,
      "--source-freeze", sourceFreezePath,
      "--repo-root", repoRoot,
      "--evidence-root", evidenceRoot,
      "--snapshot-root", snapshotRoot,
      "--output", outputPath,
    ],
  };
}

describe("heldout parent-only packet builder", () => {
  it("verifies Git state and emits a hash-bound packet without fix information", () => {
    const fixture = createFixture();
    try {
      execFileSync(process.execPath, fixture.args, { cwd: ROOT, encoding: "utf8" });
      const raw = fs.readFileSync(fixture.outputPath, "utf8");
      const receipt = JSON.parse(raw);

      expect(receipt).toMatchObject({
        artifact_type: "heldout_parent_only_packet_set",
        packet_count: 1,
        source_count: 1,
        snapshot_count: 1,
        closed_inventory: true,
        fix_information_included: false,
        vcs_history_included: false,
        network_required_for_design: false,
        candidate_accounting: {
          census_candidate_count: 1,
          admitted_candidate_count: 1,
          excluded_candidate_count: 0,
          all_candidates_accounted: true,
        },
      });
      expect(receipt.packets[0].packet_sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(receipt.packets[0].blinded_source_id).toBe("blind_source_01");
      expect(receipt.packets[0].bounded_environment_notes).toEqual(["No network is required."]);
      expect(receipt.packets[0]).not.toHaveProperty("parent_revision_evaluator_paths");
      expect(receipt.packets[0]).not.toHaveProperty("source_id");
      expect(receipt.packets[0]).not.toHaveProperty("parent_commit");
      const archivePath = path.join(
        fixture.snapshotRoot,
        receipt.packets[0].source_snapshot_archive
      );
      const archiveEntries = execFileSync("tar", ["-tf", archivePath], { encoding: "utf8" });
      expect(archiveEntries).toContain("./evaluator.py");
      expect(archiveEntries).not.toMatch(/(?:^|\/)\.git(?:\/|$)/mu);
      const manifestPath = path.join(
        fixture.snapshotRoot,
        receipt.packets[0].source_snapshot_manifest
      );
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      expect(manifest).toMatchObject({
        artifact_type: "history_free_git_tree_snapshot_manifest",
        entry_count: 4,
      });
      expect(manifest.entries.map((entry: any) => entry.path)).toEqual([
        "LICENSE",
        "SPEC.md",
        "evaluator.py",
        "test_evaluator.py",
      ]);

      const secondSnapshotRoot = path.join(fixture.root, "snapshots-second");
      const secondOutputPath = path.join(fixture.root, "packets-second.json");
      const secondArgs = [...fixture.args];
      secondArgs[secondArgs.indexOf("--snapshot-root") + 1] = secondSnapshotRoot;
      secondArgs[secondArgs.indexOf("--output") + 1] = secondOutputPath;
      execFileSync(process.execPath, secondArgs, { cwd: ROOT, encoding: "utf8" });
      const secondReceipt = JSON.parse(fs.readFileSync(secondOutputPath, "utf8"));
      expect(secondReceipt.packets[0].source_snapshot_sha256).toBe(
        receipt.packets[0].source_snapshot_sha256
      );
      expect(secondReceipt.packets[0].source_snapshot_manifest_sha256).toBe(
        receipt.packets[0].source_snapshot_manifest_sha256
      );
      expect(secondReceipt.packets[0].packet_sha256).toBe(receipt.packets[0].packet_sha256);

      expect(raw).not.toContain(fixture.parentCommit);
      expect(raw).not.toContain(fixture.fixCommit);
      expect(raw).not.toContain("fixture_source");
      expect(raw).not.toContain("fixture-source");
      expect(raw).not.toContain("historical_fault_description");
      expect(raw).not.toContain("must remain sealed");
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a registry whose declared parent tree is not the pinned Git tree", () => {
    const fixture = createFixture();
    try {
      const registry = JSON.parse(fs.readFileSync(fixture.registryPath, "utf8"));
      registry.lineages[0].parent_tree_hash = "0".repeat(40);
      writeJson(fixture.registryPath, registry);
      const result = spawnSync(process.execPath, fixture.args, { cwd: ROOT, encoding: "utf8" });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("parent_tree_hash does not match Git");
      expect(fs.existsSync(fixture.outputPath)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects census bytes that drift after the registry is frozen", () => {
    const fixture = createFixture();
    try {
      const evidenceRoot = fixture.args[fixture.args.indexOf("--evidence-root") + 1];
      fs.appendFileSync(path.join(evidenceRoot, "census.json"), "\n", "utf8");
      const result = spawnSync(process.execPath, fixture.args, { cwd: ROOT, encoding: "utf8" });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("sha256 does not match");
      expect(fs.existsSync(fixture.outputPath)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects source pin or cluster drift from the protocol-bound source freeze", () => {
    const fixture = createFixture();
    try {
      const registry = JSON.parse(fs.readFileSync(fixture.registryPath, "utf8"));
      registry.sources[0].independence_cluster = "tampered_cluster";
      writeJson(fixture.registryPath, registry);
      const result = spawnSync(process.execPath, fixture.args, { cwd: ROOT, encoding: "utf8" });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("source pin or independence cluster drifted from source freeze");
      expect(fs.existsSync(fixture.outputPath)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("leaves no partial snapshots when a post-materialization packet contract fails", () => {
    const fixture = createFixture();
    try {
      const protocolPath = fixture.args[fixture.args.indexOf("--protocol") + 1];
      const protocol = JSON.parse(fs.readFileSync(protocolPath, "utf8"));
      protocol.blind_packet_contract.allowed_fields =
        protocol.blind_packet_contract.allowed_fields.filter(
          (field: string) => field !== "packet_sha256"
        );
      writeJson(protocolPath, protocol);
      const registry = JSON.parse(fs.readFileSync(fixture.registryPath, "utf8"));
      registry.protocol_sha256 = sha256(fs.readFileSync(protocolPath, "utf8"));
      writeJson(fixture.registryPath, registry);

      const result = spawnSync(process.execPath, fixture.args, { cwd: ROOT, encoding: "utf8" });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("contains non-contract packet fields: packet_sha256");
      expect(fs.existsSync(fixture.outputPath)).toBe(false);
      expect(fs.existsSync(fixture.snapshotRoot)).toBe(true);
      expect(fs.readdirSync(fixture.snapshotRoot)).toEqual([]);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
