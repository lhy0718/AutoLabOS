import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const ANALYZER = path.join(
  ROOT,
  "studies",
  "grader-conform",
  "scripts",
  "analyze-confirmatory-results.mjs"
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

function canonicalize(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])])
  );
}

function canonicalHash(value: unknown): string {
  return sha256(JSON.stringify(canonicalize(value)));
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fileHash(filePath: string): string {
  return sha256(fs.readFileSync(filePath));
}

function createFixture(options: {
  concentrated?: boolean;
  baselineFailure?: boolean;
  fixedControlFailure?: boolean;
  baselineNotApplicable?: boolean;
  invalidPacketHash?: boolean;
  snapshotManifestMismatch?: boolean;
  reorderedFixedControls?: boolean;
  sourceClusterDrift?: boolean;
  sourcePlanDrift?: boolean;
  sourcePlanMetadataDrift?: boolean;
  weakProtocolThresholds?: boolean;
  packetFixDiff?: boolean;
  escapingSnapshotSymlink?: boolean;
  evidenceInventoryDrift?: boolean;
  duplicateCandidateId?: boolean;
} = {}): {
  root: string;
  outputPath: string;
  receiptRoot: string;
  receiptToTamper: string;
  packetPath: string;
  snapshotManifest: string;
  args: string[];
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bound-confirmatory-analysis-"));
  const receiptRoot = path.join(root, "receipts");
  const snapshotRoot = path.join(root, "snapshots");
  const evidenceRoot = path.join(root, "evidence");
  fs.mkdirSync(receiptRoot);
  fs.mkdirSync(snapshotRoot);
  fs.mkdirSync(evidenceRoot);
  const snapshotArchive = path.join(snapshotRoot, "snapshot_001.tar");
  const snapshotManifest = path.join(snapshotRoot, "snapshot_001.manifest.json");
  const snapshotTree = path.join(root, "snapshot-tree");
  const snapshotFile = path.join(snapshotTree, "evaluator.txt");
  const snapshotContent = options.escapingSnapshotSymlink
    ? "../../outside"
    : "deterministic parent evaluator fixture\n";
  fs.mkdirSync(snapshotTree);
  if (options.escapingSnapshotSymlink) {
    fs.symlinkSync(snapshotContent, snapshotFile);
  } else {
    fs.writeFileSync(snapshotFile, snapshotContent, { encoding: "utf8", mode: 0o644 });
    fs.chmodSync(snapshotFile, 0o644);
  }
  execFileSync("tar", [
    "--sort=name",
    "--mtime=@0",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "-cf", snapshotArchive,
    "-C", snapshotTree,
    ".",
  ]);
  writeJson(snapshotManifest, {
    schema_version: "1.0",
    artifact_type: "history_free_git_tree_snapshot_manifest",
    snapshot_id: "snapshot_001",
    entry_count: 1,
    entries: [{
      path: "evaluator.txt",
      mode: options.escapingSnapshotSymlink ? "120000" : "100644",
      type: options.escapingSnapshotSymlink ? "symlink" : "file",
      git_object_id: "1".repeat(40),
      content_sha256: options.snapshotManifestMismatch
        ? "0".repeat(64)
        : sha256(snapshotContent),
      bytes: Buffer.byteLength(snapshotContent),
    }],
  });
  const protocol = JSON.parse(fs.readFileSync(BASE_PROTOCOL, "utf8"));
  const baselineContracts = protocol.baseline_contracts as Array<{
    id: string;
    eligible_for_strongest_detector_union: boolean;
  }>;
  const eligibleBaselineIds = new Set(
    baselineContracts
      .filter((contract) => contract.eligible_for_strongest_detector_union)
      .map((contract) => contract.id)
  );
  const sources = Array.from({ length: 6 }, (_, index) => ({
    source_id: `sealed_source_${index + 1}`,
    blinded_source_id: `blind_source_${index + 1}`,
    independence_cluster: `cluster_${index + 1}`,
    pinned_head: sha256(`head:${index + 1}`).slice(0, 40),
  }));
  const sourceFreezePath = path.join(root, "source-freeze.json");
  writeJson(sourceFreezePath, {
    schema_version: "1.0",
    artifact_type: "heldout_source_selection_freeze",
    status: "frozen_before_heldout_probe_design_or_outcomes",
    active_sources: sources.map((source) => ({
      source_id: source.source_id,
      pinned_head: source.pinned_head,
      independence_cluster: source.independence_cluster,
    })),
    reserve_sources: [],
  });
  const sourceFreezeHash = fileHash(sourceFreezePath);
  const sourcePlanPath = path.join(root, "source-plan.json");
  writeJson(sourcePlanPath, {
    schema_version: "1.0",
    artifact_type: "heldout_registry_source_plan",
    frozen_before_probe_design: true,
    method_outcomes_observed: false,
    baseline_outcomes_observed: false,
    activated_reserve_source_ids: [],
    sources: sources.map((source, index) => ({
      source_id: source.source_id,
      cache_key: `source_${index + 1}`,
      bounded_environment_notes: [],
    })),
  });
  const boundSourcePlanHash = fileHash(sourcePlanPath);
  const sourceFreezeBinding = protocol.bindings.find(
    (binding: any) => binding.path === "studies/grader-conform/corpus/heldout-source-freeze.v1.json"
  );
  sourceFreezeBinding.sha256 = sourceFreezeHash;
  const sourcePlanBinding = protocol.bindings.find(
    (binding: any) => binding.path === "studies/grader-conform/corpus/heldout-registry-source-plan.v1.json"
  );
  sourcePlanBinding.sha256 = boundSourcePlanHash;
  if (options.weakProtocolThresholds) {
    protocol.sampling_contract.minimum_heldout_lineages = 0;
    protocol.sampling_contract.minimum_heldout_repositories = 0;
    protocol.sampling_contract.minimum_heldout_independence_clusters = 0;
    protocol.promotion_gate.machine_thresholds = {
      ...protocol.promotion_gate.machine_thresholds,
      minimum_heldout_lineages: 0,
      minimum_heldout_repositories: 0,
      minimum_heldout_independence_clusters: 0,
      minimum_unique_detections: 0,
      minimum_unique_detection_clusters: 0,
      registered_fixed_control_count: 0,
      maximum_fixed_control_false_alarms: 0,
      maximum_cluster_randomization_p_value: 1,
    };
    protocol.analysis_plan.cluster_randomization.alpha = 1;
  }
  const protocolPath = path.join(root, "protocol.json");
  writeJson(protocolPath, protocol);
  const protocolHash = fileHash(protocolPath);
  if (options.sourcePlanDrift) {
    const driftedPlan = JSON.parse(fs.readFileSync(sourcePlanPath, "utf8"));
    driftedPlan.sources[0].bounded_environment_notes.push("Post-freeze drift.");
    writeJson(sourcePlanPath, driftedPlan);
  }
  const sourcePlanHash = fileHash(sourcePlanPath);
  const lineages = Array.from({ length: 24 }, (_, index) => {
    const sourceIndex = Math.floor(index / 4);
    return {
      candidate_id: `candidate_${String(index + 1).padStart(2, "0")}`,
      anonymous_lineage_id: `lineage_${String(index + 1).padStart(2, "0")}`,
      registry_index: index,
      source_id: sources[sourceIndex].source_id,
    };
  });
  const canonicalCandidates = lineages.map((lineage) => ({
    candidate_id: lineage.candidate_id,
    source_id: lineage.source_id,
  }));
  if (options.duplicateCandidateId) lineages[1].candidate_id = lineages[0].candidate_id;
  const evidencePath = path.join(evidenceRoot, "group.json");
  writeJson(evidencePath, {
    schema_version: "1.0",
    artifact_type: "sealed_heldout_census_and_adjudication",
    status: "complete",
    exhaustive_within_queries: true,
    outcome_observed: false,
    method_or_baseline_outcomes_included: false,
    candidates: canonicalCandidates,
    exclusions: [],
    decisions: canonicalCandidates.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      decision: "admit",
    })),
  });
  const evidenceManifestPath = path.join(evidenceRoot, "manifest.json");
  writeJson(evidenceManifestPath, {
    schema_version: "1.0",
    artifact_type: "sealed_heldout_evidence_manifest",
    frozen_before_probe_design: true,
    method_outcomes_observed: false,
    baseline_outcomes_observed: false,
    closed_inventory: true,
    artifacts: [{
      group_id: "fixture_group",
      path: "group.json",
      sha256: fileHash(evidencePath),
      bytes: fs.statSync(evidencePath).size,
    }],
  });
  if (options.evidenceInventoryDrift) {
    writeJson(path.join(evidenceRoot, "unbound.json"), { hidden: true });
  }
  const evidenceManifestHash = fileHash(evidenceManifestPath);
  const registryPath = path.join(root, "registry.json");
  writeJson(registryPath, {
    schema_version: "1.0",
    artifact_type: "heldout_lineage_registry",
    protocol_sha256: protocolHash,
    source_freeze_sha256: sourceFreezeHash,
    source_plan_sha256: sourcePlanHash,
    evidence_manifest_sha256: evidenceManifestHash,
    frozen_before_probe_design: true,
    method_outcomes_observed: false,
    baseline_outcomes_observed: false,
    sources: sources.map((source, index) => ({
      ...source,
      cache_key: options.sourcePlanMetadataDrift && index === 0
        ? "drifted_source"
        : `source_${index + 1}`,
      bounded_environment_notes: [],
      independence_cluster: options.sourceClusterDrift && index === 0
        ? "tampered_cluster"
        : source.independence_cluster,
    })),
    activated_reserve_source_ids: [],
    census_bindings: [{ path: "group.json", sha256: fileHash(evidencePath) }],
    adjudication_bindings: [{ path: "group.json", sha256: fileHash(evidencePath) }],
    excluded_candidate_ids: [],
    lineages,
    fixed_control_lineage_ids: (options.reorderedFixedControls ? [...lineages].reverse() : lineages)
      .map((lineage) => lineage.anonymous_lineage_id),
  });
  const registryHash = fileHash(registryPath);
  const packets = lineages.map((lineage) => {
    const corePacket = {
      anonymous_lineage_id: lineage.anonymous_lineage_id,
      registry_index: lineage.registry_index,
      blinded_source_id: sources[Math.floor(lineage.registry_index / 4)].blinded_source_id,
      license_status: "verified_for_local_execution_and_derived_measurements",
      source_snapshot_archive: "snapshot_001.tar",
      source_snapshot_sha256: fileHash(snapshotArchive),
      source_snapshot_bytes: fs.statSync(snapshotArchive).size,
      source_snapshot_manifest: "snapshot_001.manifest.json",
      source_snapshot_manifest_sha256: fileHash(snapshotManifest),
      source_snapshot_manifest_bytes: fs.statSync(snapshotManifest).size,
      bounded_environment_notes: [],
      ...(options.packetFixDiff && lineage.registry_index === 0
        ? { fix_diff: "hidden post-parent information" }
        : {}),
    };
    return {
      ...corePacket,
      packet_sha256: options.invalidPacketHash
        ? "0".repeat(64)
        : canonicalHash(corePacket),
    };
  });
  const packetPath = path.join(root, "packets.json");
  writeJson(packetPath, {
    schema_version: "1.0",
    artifact_type: "heldout_parent_only_packet_set",
    registry_sha256: registryHash,
    protocol_sha256: protocolHash,
    source_freeze_sha256: sourceFreezeHash,
    packet_count: 24,
    source_count: 6,
    closed_inventory: true,
    fix_information_included: false,
    vcs_history_included: false,
    candidate_accounting: {
      census_candidate_count: 24,
      admitted_candidate_count: 24,
      excluded_candidate_count: 0,
      all_candidates_accounted: true,
    },
    packets,
  });
  const packetHash = fileHash(packetPath);
  const probes = lineages.map((lineage) => ({
    lineage_id: lineage.anonymous_lineage_id,
    packet_sha256: packets[lineage.registry_index].packet_sha256,
    command_sha256: sha256(`probe-command:${lineage.anonymous_lineage_id}`),
    generated_case_budget: 2,
    wall_clock_budget_seconds: 1,
  }));
  const probeManifestPath = path.join(root, "probe-manifest.json");
  writeJson(probeManifestPath, {
    schema_version: "1.0",
    artifact_type: "blinded_probe_manifest",
    protocol_sha256: protocolHash,
    packet_set_sha256: packetHash,
    frozen_before_unblinding: true,
    probes,
  });
  const probeManifestHash = fileHash(probeManifestPath);
  const baselineItems = lineages.flatMap((lineage) => baselineContracts.map((contract) => {
    const forceInapplicable = options.baselineNotApplicable
      && lineage.registry_index === 1
      && contract.id === "schema_and_static_checks";
    const applicable = eligibleBaselineIds.has(contract.id) && !forceInapplicable;
    return {
      lineage_id: lineage.anonymous_lineage_id,
      baseline_id: contract.id,
      applicability: applicable ? "applicable" : "not_applicable",
      command_sha256: applicable
        ? sha256(`baseline-command:${lineage.anonymous_lineage_id}:${contract.id}`)
        : null,
      generated_case_budget: applicable ? 2 : 0,
      wall_clock_budget_seconds: applicable ? 1 : 0,
      ...(applicable ? {} : {
        not_applicable_reason: forceInapplicable
          ? "Fixture declares an eligible detector inapplicable."
          : "Fixture diagnostic is not exercised.",
      }),
    };
  }));
  const baselineManifestPath = path.join(root, "baseline-manifest.json");
  writeJson(baselineManifestPath, {
    schema_version: "1.0",
    artifact_type: "blinded_baseline_manifest",
    protocol_sha256: protocolHash,
    packet_set_sha256: packetHash,
    frozen_before_unblinding: true,
    items: baselineItems,
  });
  const baselineManifestHash = fileHash(baselineManifestPath);
  let receiptCounter = 0;
  let receiptToTamper = "";
  function bindReceipt(receipt: Record<string, unknown>): { path: string; sha256: string } {
    receiptCounter += 1;
    const filename = `receipt_${String(receiptCounter).padStart(4, "0")}.json`;
    const filePath = path.join(receiptRoot, filename);
    writeJson(filePath, receipt);
    if (!receiptToTamper) receiptToTamper = filePath;
    return { path: filename, sha256: fileHash(filePath) };
  }
  const receiptLineages = lineages.map((lineage) => {
    const sourceIndex = Math.floor(lineage.registry_index / 4);
    const localIndex = lineage.registry_index % 4;
    const methodOnly = localIndex === 1 && (!options.concentrated || sourceIndex === 0);
    const baselineDetected = localIndex === 0;
    const methodDetected = baselineDetected || methodOnly;
    const fixedControlFailure = options.fixedControlFailure && lineage.registry_index === 0;
    const probe = probes[lineage.registry_index];
    const probeItemHash = canonicalHash(probe);
    const method = {
      parent: bindReceipt({
        schema_version: "1.0",
        artifact_type: "method_execution_receipt",
        lineage_id: lineage.anonymous_lineage_id,
        revision_role: "parent",
        manifest_item_sha256: probeItemHash,
        command_sha256: probe.command_sha256,
        generated_case_count: 2,
        executed: true,
        exit_code: 0,
        relation_holds: !methodDetected,
        runtime_seconds: 0.01,
      }),
      fixed: bindReceipt({
        schema_version: "1.0",
        artifact_type: "method_execution_receipt",
        lineage_id: lineage.anonymous_lineage_id,
        revision_role: "fixed",
        manifest_item_sha256: probeItemHash,
        command_sha256: probe.command_sha256,
        generated_case_count: 2,
        executed: !fixedControlFailure,
        exit_code: fixedControlFailure ? null : 0,
        relation_holds: fixedControlFailure ? null : true,
        runtime_seconds: 0.01,
      }),
    };
    const baselines = Object.fromEntries(baselineContracts.map((contract) => {
      const item = baselineItems.find(
        (candidate) => candidate.lineage_id === lineage.anonymous_lineage_id
          && candidate.baseline_id === contract.id
      )!;
      if (item.applicability === "not_applicable") return [contract.id, null];
      const itemHash = canonicalHash(item);
      const commandHash = item.command_sha256 as string;
      const forceFailure = options.baselineFailure
        && sourceIndex === 0
        && localIndex === 1
        && contract.id === "schema_and_static_checks";
      return [contract.id, {
        parent: bindReceipt({
          schema_version: "1.0",
          artifact_type: "baseline_execution_receipt",
          baseline_id: contract.id,
          lineage_id: lineage.anonymous_lineage_id,
          revision_role: "parent",
          manifest_item_sha256: itemHash,
          command_sha256: commandHash,
          generated_case_count: 2,
          executed: !forceFailure,
          exit_code: forceFailure ? null : 0,
          fault_signal: forceFailure
            ? null
            : contract.id === "parent_native_tests" && baselineDetected,
          runtime_seconds: 0.01,
        }),
        fixed: bindReceipt({
          schema_version: "1.0",
          artifact_type: "baseline_execution_receipt",
          baseline_id: contract.id,
          lineage_id: lineage.anonymous_lineage_id,
          revision_role: "fixed",
          manifest_item_sha256: itemHash,
          command_sha256: commandHash,
          generated_case_count: 2,
          executed: true,
          exit_code: 0,
          fault_signal: false,
          runtime_seconds: 0.01,
        }),
      }];
    }));
    return {
      lineage_id: lineage.anonymous_lineage_id,
      method,
      baselines,
    };
  });
  const inputPath = path.join(root, "receipt-index.json");
  writeJson(inputPath, {
    schema_version: "1.0",
    artifact_type: "confirmatory_receipt_index",
    protocol_sha256: protocolHash,
    registry_sha256: registryHash,
    source_freeze_sha256: sourceFreezeHash,
    source_plan_sha256: sourcePlanHash,
    evidence_manifest_sha256: evidenceManifestHash,
    packet_set_sha256: packetHash,
    probe_manifest_sha256: probeManifestHash,
    baseline_manifest_sha256: baselineManifestHash,
    lineages: receiptLineages,
    deviations: [],
  });
  const outputPath = path.join(root, "analysis.json");
  return {
    root,
    outputPath,
    receiptRoot,
    receiptToTamper,
    packetPath,
    snapshotManifest,
    args: [
      ANALYZER,
      "--input", inputPath,
      "--protocol", protocolPath,
      "--source-freeze", sourceFreezePath,
      "--source-plan", sourcePlanPath,
      "--registry", registryPath,
      "--packets", packetPath,
      "--probe-manifest", probeManifestPath,
      "--baseline-manifest", baselineManifestPath,
      "--evidence-root", evidenceRoot,
      "--snapshot-root", snapshotRoot,
      "--receipt-root", receiptRoot,
      "--output", outputPath,
    ],
  };
}

function runFixture(fixture: ReturnType<typeof createFixture>): Record<string, any> {
  execFileSync(process.execPath, fixture.args, { cwd: ROOT, encoding: "utf8" });
  return JSON.parse(fs.readFileSync(fixture.outputPath, "utf8"));
}

describe("bound confirmatory study analysis", () => {
  it("passes receipt statistics only for a six-cluster gain and still requires independent replay", () => {
    const passing = createFixture();
    const concentrated = createFixture({ concentrated: true });
    const baselineFailure = createFixture({ baselineFailure: true });
    const fixedControlFailure = createFixture({ fixedControlFailure: true });
    const baselineNotApplicable = createFixture({ baselineNotApplicable: true });
    try {
      const passingReceipt = runFixture(passing);
      const concentratedReceipt = runFixture(concentrated);
      const failureReceipt = runFixture(baselineFailure);
      const fixedControlFailureReceipt = runFixture(fixedControlFailure);
      const inapplicableReceipt = runFixture(baselineNotApplicable);

      expect(passingReceipt).toMatchObject({
        schema_version: "2.0",
        lineage_count: 24,
        source_count: 6,
        independence_cluster_count: 6,
        confirmatory_receipt_analysis_gate_passed: true,
        independent_execution_provenance_verified: false,
        confirmatory_empirical_gate_passed: false,
        paper_candidate_promotion_authorized: false,
        paper_scale_claim_authorized: false,
      });
      expect(passingReceipt.summary.method_only_count).toBe(6);
      expect(passingReceipt.primary_exact_cluster_randomization.two_sided_exact_p_value).toBe(0.03125);
      expect(passingReceipt.promotion_checks.every((check: any) => check.passed)).toBe(true);

      expect(concentratedReceipt.confirmatory_receipt_analysis_gate_passed).toBe(false);
      expect(
        concentratedReceipt.promotion_checks.find(
          (check: any) => check.id === "unique_detection_cluster_coverage"
        ).passed
      ).toBe(false);

      expect(failureReceipt.summary.method_only_count).toBe(5);
      expect(
        failureReceipt.summary.eligible_baseline_execution_failure_lineage_count
      ).toBe(1);
      expect(failureReceipt.confirmatory_empirical_gate_passed).toBe(false);

      expect(fixedControlFailureReceipt.confirmatory_empirical_gate_passed).toBe(false);
      expect(
        fixedControlFailureReceipt.promotion_checks.find(
          (check: any) => check.id === "registered_fixed_controls"
        ).observed.executed_count
      ).toBe(23);

      expect(inapplicableReceipt.summary.method_only_count).toBe(5);
      expect(inapplicableReceipt.summary.eligible_baseline_inapplicable_lineage_count).toBe(1);
      expect(inapplicableReceipt.confirmatory_receipt_analysis_gate_passed).toBe(false);
    } finally {
      fs.rmSync(passing.root, { recursive: true, force: true });
      fs.rmSync(concentrated.root, { recursive: true, force: true });
      fs.rmSync(baselineFailure.root, { recursive: true, force: true });
      fs.rmSync(fixedControlFailure.root, { recursive: true, force: true });
      fs.rmSync(baselineNotApplicable.root, { recursive: true, force: true });
    }
  });

  it("rejects self-consistent outer bindings with invalid packet, snapshot, or control semantics", () => {
    const attacks = [
      {
        fixture: createFixture({ invalidPacketHash: true }),
        message: "packet_sha256 does not match packet content",
      },
      {
        fixture: createFixture({ snapshotManifestMismatch: true }),
        message: "archive content does not match manifest",
      },
      {
        fixture: createFixture({ reorderedFixedControls: true }),
        message: "Fixed controls must be the first registered lineages",
      },
      {
        fixture: createFixture({ sourceClusterDrift: true }),
        message: "source pin or independence cluster drifted from source freeze",
      },
      {
        fixture: createFixture({ sourcePlanDrift: true }),
        message: "Protocol does not bind the supplied source-plan bytes",
      },
      {
        fixture: createFixture({ sourcePlanMetadataDrift: true }),
        message: "registry metadata drifted from the source plan",
      },
      {
        fixture: createFixture({ weakProtocolThresholds: true }),
        message: "Promotion thresholds drift from the frozen sampling and analysis contracts",
      },
      {
        fixture: createFixture({ packetFixDiff: true }),
        message: "Blind artifact contains prohibited field",
      },
      {
        fixture: createFixture({ escapingSnapshotSymlink: true }),
        message: "Tar symlink escapes snapshot root",
      },
      {
        fixture: createFixture({ evidenceInventoryDrift: true }),
        message: "Evidence root does not match the sealed manifest closed inventory",
      },
      {
        fixture: createFixture({ duplicateCandidateId: true }),
        message: "Duplicate candidate_id",
      },
    ];
    try {
      for (const attack of attacks) {
        const result = spawnSync(process.execPath, attack.fixture.args, {
          cwd: ROOT,
          encoding: "utf8",
        });
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(attack.message);
        expect(fs.existsSync(attack.fixture.outputPath)).toBe(false);
      }
    } finally {
      for (const attack of attacks) {
        fs.rmSync(attack.fixture.root, { recursive: true, force: true });
      }
    }
  });

  it("rejects receipt bytes that drift after the index is frozen", () => {
    const fixture = createFixture();
    try {
      fs.appendFileSync(fixture.receiptToTamper, "\n", "utf8");
      const result = spawnSync(process.execPath, fixture.args, {
        cwd: ROOT,
        encoding: "utf8",
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("sha256 does not match receipt bytes");
      expect(fs.existsSync(fixture.outputPath)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an unindexed receipt in the supposedly closed receipt root", () => {
    const fixture = createFixture();
    try {
      writeJson(path.join(fixture.receiptRoot, "unindexed.json"), { hidden: true });
      const result = spawnSync(process.execPath, fixture.args, {
        cwd: ROOT,
        encoding: "utf8",
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("closed receipt index inventory");
      expect(fs.existsSync(fixture.outputPath)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
