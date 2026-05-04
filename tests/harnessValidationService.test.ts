import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifyHarnessIssueCode,
  runHarnessValidation
} from "../src/core/validation/harnessValidationService.js";
import {
  buildMinimalLiveFixtureReviewArtifacts,
  writeLiveFixtureWorkspace
} from "./helpers/liveFixtureWorkspace.js";
import { VALIDATION_WORKSPACE_ROOT_ENV } from "../src/validationWorkspace.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import { RunRecord } from "../src/types.js";

const tempDirs: string[] = [];
let originalValidationWorkspaceRoot: string | undefined;
let originalValidationWorkspaceRootKnown = false;

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  if (originalValidationWorkspaceRootKnown) {
    if (originalValidationWorkspaceRoot === undefined) {
      delete process.env[VALIDATION_WORKSPACE_ROOT_ENV];
    } else {
      process.env[VALIDATION_WORKSPACE_ROOT_ENV] = originalValidationWorkspaceRoot;
    }
    originalValidationWorkspaceRoot = undefined;
    originalValidationWorkspaceRootKnown = false;
  }
});

describe("harnessValidationService", () => {
  it("scans workspace and test run stores with classified findings", async () => {
    const workspace = createTempWorkspace("autolabos-harness-service-");
    await writeFile(path.join(workspace, "ISSUES.md"), "## Issue: missing-fields\n- Status: open\n", "utf8");

    await writeJson(path.join(workspace, ".autolabos", "runs", "runs.json"), {
      runs: [{ id: "workspace-run", status: "completed", graph: { nodeStates: {} } }]
    });
    await mkdir(path.join(workspace, ".autolabos", "runs", "workspace-run"), { recursive: true });

    await writeJson(path.join(workspace, "test", "fixtures", ".autolabos", "runs", "runs.json"), {
      runs: [{ id: "test-run", status: "running", graph: { nodeStates: {} } }]
    });

    const report = await runHarnessValidation({
      workspaceRoot: workspace,
      includeWorkspaceRuns: true,
      includeTestRunStores: true
    });

    expect(report.runStoresChecked).toBe(2);
    expect(report.runsChecked).toBe(2);
    expect(report.findings.some((item) => item.scope === "workspace")).toBe(true);
    expect(report.findings.some((item) => item.scope === "test_records")).toBe(true);
    expect(report.findings.some((item) => item.code === "run_directory_missing")).toBe(true);
    expect(report.countsByKind.malformed_issue).toBeGreaterThan(0);
    expect(report.countsByKind.missing_artifact).toBeGreaterThan(0);
  });

  it("classifies source path linkage failures as broken evidence links", () => {
    expect(classifyHarnessIssueCode("paper_claim_source_path_missing")).toBe("broken_evidence_link");
    expect(classifyHarnessIssueCode("paper_claim_source_path_placeholder")).toBe("broken_evidence_link");
  });

  it("classifies runtime contract metadata failures as contract metadata", () => {
    expect(classifyHarnessIssueCode("runtime_contract_gate_missing")).toBe("contract_metadata");
  });

  it("reports missing prompt contract metadata through harness validation", async () => {
    const workspace = createTempWorkspace("autolabos-harness-contract-metadata-");
    await writeFile(path.join(workspace, "ISSUES.md"), "## Issue: ok\n- Status: open\n", "utf8");
    await mkdir(path.join(workspace, "node-prompts"), { recursive: true });
    await writeFile(path.join(workspace, "node-prompts", "analyze_results.md"), "# analyze_results\n", "utf8");

    const report = await runHarnessValidation({
      workspaceRoot: workspace,
      includeWorkspaceRuns: false,
      includeTestRunStores: false
    });

    expect(report.findings.some((finding) => finding.code === "runtime_contract_gate_missing")).toBe(true);
    expect(report.countsByKind.contract_metadata).toBeGreaterThan(0);
  });

  it("falls back to parent directory ISSUES.md when not present in workspace root (LV-028)", async () => {
    const parent = createTempWorkspace("autolabos-harness-parent-");
    const child = path.join(parent, "child");
    await mkdir(child, { recursive: true });

    // Place ISSUES.md only in the parent directory
    await writeFile(path.join(parent, "ISSUES.md"), "## Issue: parent-level\n- Status: open\n", "utf8");

    const report = await runHarnessValidation({
      workspaceRoot: child,
      includeWorkspaceRuns: false,
      includeTestRunStores: false
    });

    expect(report.findings.some((f) => f.code === "issues_file_missing")).toBe(false);
  });

  it("reports issues_file_missing when a non-repo workspace has no local or parent ISSUES.md", async () => {
    const parent = createTempWorkspace("autolabos-harness-noissuefile-");
    const child = path.join(parent, "child");
    await mkdir(child, { recursive: true });

    const report = await runHarnessValidation({
      workspaceRoot: child,
      includeWorkspaceRuns: false,
      includeTestRunStores: false
    });

    expect(report.findings.some((f) => f.code === "issues_file_missing")).toBe(true);
  });

  it("suppresses issues_file_missing when every observed run declares validation_scope=live_fixture", async () => {
    const workspace = createTempWorkspace("autolabos-harness-live-fixture-");
    originalValidationWorkspaceRoot = process.env[VALIDATION_WORKSPACE_ROOT_ENV];
    originalValidationWorkspaceRootKnown = true;
    process.env[VALIDATION_WORKSPACE_ROOT_ENV] = workspace;
    await writeLiveFixtureWorkspace({
      workspaceRoot: workspace,
      runId: "fixture-run",
      includeConfig: false,
      artifacts: buildMinimalLiveFixtureReviewArtifacts("2026-03-28T12:00:00.000Z"),
      now: "2026-03-28T12:00:00.000Z"
    });

    const report = await runHarnessValidation({
      workspaceRoot: workspace,
      includeWorkspaceRuns: true,
      includeTestRunStores: false
    });

    expect(report.findings.some((f) => f.code === "issues_file_missing")).toBe(false);
  });

  it("ignores transient test/.tmp run stores when scanning reproducibility records", async () => {
    const workspace = createTempWorkspace("autolabos-harness-ignore-tmp-");
    await writeFile(path.join(workspace, "ISSUES.md"), "## Issue: ok\n- Status: open\n", "utf8");

    await writeJson(path.join(workspace, ".autolabos", "runs", "runs.json"), {
      runs: [{ id: "workspace-run", status: "completed", graph: { nodeStates: {} } }]
    });
    await mkdir(path.join(workspace, ".autolabos", "runs", "workspace-run"), { recursive: true });

    await writeJson(path.join(workspace, "test", ".tmp", "session-1", ".autolabos", "runs", "runs.json"), {
      runs: [{ id: "tmp-run", status: "running", graph: { nodeStates: {} } }]
    });

    const report = await runHarnessValidation({
      workspaceRoot: workspace,
      includeWorkspaceRuns: true,
      includeTestRunStores: true
    });

    expect(report.targets.find((target) => target.scope === "test_records")?.runStoreCount).toBe(0);
    expect(report.runsChecked).toBe(1);
  });

  it("scans live-fixture run stores under an external validation root when configured", async () => {
    originalValidationWorkspaceRoot = process.env[VALIDATION_WORKSPACE_ROOT_ENV];
    originalValidationWorkspaceRootKnown = true;

    const workspace = createTempWorkspace("autolabos-harness-external-workspace-");
    const externalValidationRoot = createTempWorkspace("autolabos-harness-external-validation-root-");
    process.env[VALIDATION_WORKSPACE_ROOT_ENV] = externalValidationRoot;

    await writeFile(path.join(workspace, "ISSUES.md"), "## Issue: ok\n- Status: open\n", "utf8");
    const fixtureWorkspace = path.join(externalValidationRoot, ".live", "fixture-one");
    await writeLiveFixtureWorkspace({
      workspaceRoot: fixtureWorkspace,
      runId: "fixture-run",
      includeConfig: false,
      artifacts: buildMinimalLiveFixtureReviewArtifacts("2026-03-28T12:00:00.000Z"),
      now: "2026-03-28T12:00:00.000Z"
    });

    const report = await runHarnessValidation({
      workspaceRoot: workspace,
      includeWorkspaceRuns: false,
      includeTestRunStores: true
    });

    expect(report.targets.find((target) => target.scope === "test_records")?.runStoreCount).toBe(1);
    expect(report.runsChecked).toBe(1);
    expect(report.findings.some((f) => f.code === "issues_file_missing")).toBe(false);
  });

  it("reports long-run resume drift across runs.json, run_record, and checkpoints", async () => {
    const workspace = createTempWorkspace("autolabos-harness-long-run-resume-");
    await writeFile(path.join(workspace, "ISSUES.md"), "## Active issues\nnone\n", "utf8");

    const run = makeRunRecord("long-run", 1);
    const runsDir = path.join(workspace, ".autolabos", "runs");
    const runDir = path.join(runsDir, run.id);
    const checkpointsDir = path.join(runDir, "checkpoints");
    await writeJson(path.join(runsDir, "runs.json"), {
      version: 3,
      runs: [run]
    });
    await writeJson(path.join(runDir, "run_record.json"), run);
    await writeFile(
      path.join(runDir, "events.jsonl"),
      `${JSON.stringify({
        id: "evt-long-run",
        type: "NODE_COMPLETED",
        timestamp: "2026-04-04T00:00:00.000Z",
        runId: run.id,
        node: "collect_papers",
        payload: {}
      })}\n`,
      "utf8"
    );

    await writeJson(path.join(checkpointsDir, "0001-collect_papers-after.json"), {
      seq: 1,
      runId: run.id,
      node: "collect_papers",
      phase: "after",
      createdAt: "2026-04-04T00:01:00.000Z",
      runSnapshot: run
    });
    await writeJson(path.join(checkpointsDir, "0002-analyze_papers-before.json"), {
      seq: 2,
      runId: run.id,
      node: "analyze_papers",
      phase: "before",
      createdAt: "2026-04-04T00:02:00.000Z",
      runSnapshot: makeRunRecord(run.id, 2)
    });
    await writeJson(path.join(checkpointsDir, "latest.json"), {
      seq: 1,
      node: "collect_papers",
      phase: "after",
      createdAt: "2026-04-04T00:01:00.000Z",
      file: "0001-collect_papers-after.json"
    });

    const report = await runHarnessValidation({
      workspaceRoot: workspace,
      includeWorkspaceRuns: true,
      includeTestRunStores: false
    });

    const codes = new Set(report.findings.map((finding) => finding.code));
    expect(codes).toContain("checkpoint_latest_stale_for_resume");
    expect(codes).toContain("runs_json_stale_vs_checkpoint");
    expect(codes).toContain("run_record_stale_vs_checkpoint");
    expect(report.countsByKind.status_artifact_mismatch).toBeGreaterThanOrEqual(3);
  });
});

function createTempWorkspace(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeRunRecord(id: string, checkpointSeq: number): RunRecord {
  const graph = createDefaultGraphState();
  graph.checkpointSeq = checkpointSeq;
  graph.currentNode = checkpointSeq > 1 ? "analyze_papers" : "collect_papers";
  graph.nodeStates.collect_papers = {
    status: "completed",
    updatedAt: "2026-04-04T00:01:00.000Z"
  };
  if (checkpointSeq > 1) {
    graph.nodeStates.analyze_papers = {
      status: "running",
      updatedAt: "2026-04-04T00:02:00.000Z"
    };
  }
  return {
    version: 3,
    workflowVersion: 3,
    id,
    title: "Long Run",
    topic: "Long run resume audit",
    constraints: [],
    objectiveMetric: "resume consistency",
    status: "paused",
    currentNode: graph.currentNode,
    latestSummary: "Paused for long-run audit.",
    nodeThreads: {},
    createdAt: "2026-04-04T00:00:00.000Z",
    updatedAt: checkpointSeq > 1 ? "2026-04-04T00:02:00.000Z" : "2026-04-04T00:01:00.000Z",
    graph,
    memoryRefs: {
      runContextPath: `.autolabos/runs/${id}/memory/run_context.json`,
      longTermPath: `.autolabos/runs/${id}/memory/long_term.jsonl`,
      episodePath: `.autolabos/runs/${id}/memory/episodes.jsonl`
    }
  };
}
