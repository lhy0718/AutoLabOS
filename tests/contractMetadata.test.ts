import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { validateRuntimeContractMetadata } from "../src/core/runtime/contractMetadata.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("runtime contract metadata", () => {
  it("accepts node prompt and local skill frontmatter with gate and validation metadata", async () => {
    const workspace = createWorkspace();
    await writeContractFile(
      path.join(workspace, "node-prompts", "analyze_results.md"),
      {
        contract_version: "1",
        contract_kind: "node_prompt",
        runtime_contract: "true",
        node_id: "analyze_results",
        gate: "evidence_grounded_result_synthesis",
        validation: "result_analysis_presentation_and_harness"
      },
      "# analyze_results\n"
    );
    await writeContractFile(
      path.join(workspace, ".codex", "skills", "paper-scale-research-loop", "SKILL.md"),
      {
        name: "paper-scale-research-loop",
        description: "Paper-scale research quality loop.",
        contract_version: "1",
        contract_kind: "codex_skill",
        runtime_contract: "true",
        gate: "paper_scale_evidence_ceiling",
        validation: "paper_quality_bar_review"
      },
      "# Paper-Scale Research Loop\n"
    );

    const report = await validateRuntimeContractMetadata(workspace);

    expect(report.contracts).toHaveLength(2);
    expect(report.issues).toEqual([]);
  });

  it("reports missing and mismatched runtime contract metadata", async () => {
    const workspace = createWorkspace();
    await mkdir(path.join(workspace, "node-prompts"), { recursive: true });
    await writeFile(path.join(workspace, "node-prompts", "review.md"), "# review\n", "utf8");
    await writeContractFile(
      path.join(workspace, ".codex", "skills", "demo", "SKILL.md"),
      {
        name: "demo",
        contract_version: "2",
        contract_kind: "node_prompt",
        runtime_contract: "false",
        gate: "demo_gate",
        validation: "demo_validation"
      },
      "# Demo\n"
    );

    const report = await validateRuntimeContractMetadata(workspace);
    const codes = report.issues.map((issue) => issue.code);

    expect(codes).toContain("runtime_contract_contract_version_missing");
    expect(codes).toContain("runtime_contract_node_id_mismatch");
    expect(codes).toContain("runtime_contract_version_unsupported");
    expect(codes).toContain("runtime_contract_kind_mismatch");
    expect(codes).toContain("runtime_contract_flag_invalid");
  });
});

function createWorkspace(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "autolabos-contract-metadata-"));
  tempDirs.push(dir);
  return dir;
}

async function writeContractFile(
  filePath: string,
  metadata: Record<string, string>,
  body: string
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const frontmatter = [
    "---",
    ...Object.entries(metadata).map(([key, value]) => `${key}: ${value}`),
    "---",
    "",
    body
  ].join("\n");
  await writeFile(filePath, frontmatter, "utf8");
}
