import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  verifyResearchMilestone,
  type ResearchMilestoneContract
} from "../src/core/researchMilestoneAudit.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("research milestone audit", () => {
  it("achieves a milestone only when every hash-bound assertion passes", async () => {
    const workspace = await makeWorkspace();
    const evidence = {
      status: "accepted",
      score: 0.92,
      findings: ["traceable", "reproducible"]
    };
    const evidencePath = path.join(workspace, "evidence", "report.json");
    await writeJson(evidencePath, evidence);
    await writeContract(workspace, {
      schema_version: "1.0",
      milestone_id: "portable-study",
      target_state: "submission_candidate",
      evidence_root: ".",
      requirements: [{
        id: "evidence_gate",
        label: "Evidence gate passes",
        target_node: "review",
        required: true,
        evidence: [{
          path: "evidence/report.json",
          sha256: await sha256File(evidencePath),
          assertions: [
            { pointer: "/status", operator: "equals", expected: "accepted" },
            { pointer: "/score", operator: "gte", expected: 0.9 },
            { pointer: "/findings", operator: "min_items", expected: 2 },
            { pointer: "/findings", operator: "contains", expected: "traceable" }
          ]
        }]
      }]
    });

    const result = await verifyResearchMilestone({
      cwd: workspace,
      contractPath: "milestone.json",
      outDir: "audit"
    });

    expect(result.report.verdict).toBe("achieved");
    expect(result.report.achieved).toBe(true);
    expect(result.report.summary).toEqual({
      requirement_count: 1,
      passed_requirement_count: 1,
      failed_requirement_count: 0
    });
    expect(result.report.requirements[0]?.evidence[0]?.assertions.every((item) => item.passed)).toBe(true);
    expect(await readFile(path.join(workspace, result.summary_path), "utf8")).toContain("Verdict: achieved");
  });

  it("keeps missing, unbound, and assertion-failing evidence incomplete and groups next actions", async () => {
    const workspace = await makeWorkspace();
    const presentPath = path.join(workspace, "evidence", "present.json");
    await writeJson(presentPath, { complete: false });
    await writeContract(workspace, {
      schema_version: "1.0",
      milestone_id: "multi-stage-study",
      target_state: "ready",
      evidence_root: ".",
      requirements: [
        {
          id: "execution_evidence",
          label: "Execution evidence is complete",
          target_node: "run_experiments",
          required: true,
          evidence: [{
            path: "evidence/present.json",
            sha256: await sha256File(presentPath),
            assertions: [{ pointer: "/complete", operator: "equals", expected: true }]
          }]
        },
        {
          id: "review_evidence",
          label: "Review evidence is bound",
          target_node: "review",
          required: true,
          evidence: [{ path: "evidence/present.json", sha256: null }]
        },
        {
          id: "analysis_evidence",
          label: "Analysis evidence exists",
          target_node: "analyze_results",
          required: true,
          evidence: [{ path: "evidence/missing.json", sha256: null }]
        }
      ]
    });

    const result = await verifyResearchMilestone({
      cwd: workspace,
      contractPath: "milestone.json",
      outDir: "audit"
    });

    expect(result.report.verdict).toBe("incomplete");
    expect(result.report.achieved).toBe(false);
    expect(result.report.summary.failed_requirement_count).toBe(3);
    expect(result.report.requirements[0]?.evidence[0]?.issues).toContain("evidence_assertion_failed");
    expect(result.report.requirements[1]?.evidence[0]?.issues).toContain("evidence_hash_unbound");
    expect(result.report.requirements[2]?.evidence[0]?.issues).toContain("evidence_file_missing");
    expect(result.report.next_actions.map((item) => item.target_node)).toEqual([
      "analyze_results",
      "review",
      "run_experiments"
    ]);
  });

  it("detects byte drift after a contract has bound the evidence hash", async () => {
    const workspace = await makeWorkspace();
    const evidencePath = path.join(workspace, "evidence", "report.json");
    await writeJson(evidencePath, { status: "accepted" });
    const expectedSha256 = await sha256File(evidencePath);
    await writeContract(workspace, oneRequirementContract("evidence/report.json", expectedSha256));
    await writeJson(evidencePath, { status: "rewritten" });

    const result = await verifyResearchMilestone({
      cwd: workspace,
      contractPath: "milestone.json",
      outDir: "audit"
    });

    expect(result.report.verdict).toBe("incomplete");
    expect(result.report.requirements[0]?.evidence[0]?.issues).toContain("evidence_hash_mismatch");
  });

  it("rejects symbolic-link evidence and reports malformed contracts as invalid", async () => {
    const workspace = await makeWorkspace();
    const outside = path.join(workspace, "outside.json");
    await writeJson(outside, { status: "accepted" });
    await symlink(outside, path.join(workspace, "evidence", "linked.json"));
    await writeContract(workspace, oneRequirementContract("evidence/linked.json", await sha256File(outside)));

    const linked = await verifyResearchMilestone({
      cwd: workspace,
      contractPath: "milestone.json",
      outDir: "linked-audit"
    });
    expect(linked.report.requirements[0]?.evidence[0]?.issues).toContain("evidence_symbolic_link");

    await symlink(path.join(workspace, "evidence"), path.join(workspace, "linked-output"));
    await expect(verifyResearchMilestone({
      cwd: workspace,
      contractPath: "milestone.json",
      outDir: "linked-output/audit"
    })).rejects.toThrow("Milestone audit output must not traverse symbolic links.");

    await writeJson(path.join(workspace, "invalid.json"), {
      schema_version: "1.0",
      milestone_id: "invalid-study",
      target_state: "ready",
      evidence_root: ".",
      requirements: [{
        id: "invalid path",
        label: "Invalid requirement",
        target_node: "review",
        required: false,
        evidence: []
      }, {
        id: "invalid_assertion",
        label: "Invalid numeric assertion",
        target_node: "review",
        required: true,
        evidence: [{
          path: "evidence/report.json",
          sha256: null,
          assertions: [{ pointer: "/score", operator: "gte", expected: "high" }]
        }]
      }]
    });
    const invalid = await verifyResearchMilestone({
      cwd: workspace,
      contractPath: "invalid.json",
      outDir: "invalid-audit"
    });
    expect(invalid.report.verdict).toBe("invalid_contract");
    expect(invalid.report.contract_issues).toEqual(expect.arrayContaining([
      "contract_requirement_id_invalid:0",
      "contract_requirement_must_be_required:0",
      "contract_requirement_evidence_invalid:0",
      "contract_assertion_expected_invalid:1:0:0"
    ]));
  });
});

async function makeWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-milestone-"));
  tempDirs.push(workspace);
  await mkdir(path.join(workspace, "evidence"), { recursive: true });
  return workspace;
}

async function writeContract(workspace: string, contract: ResearchMilestoneContract): Promise<void> {
  await writeJson(path.join(workspace, "milestone.json"), contract);
}

function oneRequirementContract(evidencePath: string, sha256: string): ResearchMilestoneContract {
  return {
    schema_version: "1.0",
    milestone_id: "drift-check",
    target_state: "accepted",
    evidence_root: ".",
    requirements: [{
      id: "artifact_integrity",
      label: "Artifact integrity is preserved",
      target_node: "review",
      required: true,
      evidence: [{ path: evidencePath, sha256 }]
    }]
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}
