import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { generateFullSeedAuditDemo } from "../src/core/audit/auditDemoBundle.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("full AGB audit demo", () => {
  it("covers AGB-001 through AGB-010 with expected blockers or literature warnings", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-full-audit-demo-"));
    tempDirs.push(workspace);

    const manifest = await generateFullSeedAuditDemo({
      cwd: workspace,
      outDir: "outputs/audit-full-seeds"
    });

    expect(manifest.entries.map((entry) => entry.seed_id)).toEqual([
      "AGB-001",
      "AGB-002",
      "AGB-003",
      "AGB-004",
      "AGB-005",
      "AGB-006",
      "AGB-007",
      "AGB-008",
      "AGB-009",
      "AGB-010"
    ]);
    expect(manifest.all_expected_outcomes_met).toBe(true);
    expect(manifest.entries.find((entry) => entry.seed_id === "AGB-007")?.actual_verdict).toBe("needs-review");
    expect(manifest.entries.find((entry) => entry.seed_id === "AGB-008")?.actual_blockers).toContain("literature_exclusion_reasons_missing");
    expect(manifest.entries.find((entry) => entry.seed_id === "AGB-009")?.actual_blockers).toContain("result_table_missing");

    const claimEvidence = await readFile(
      path.join(workspace, "outputs", "audit-full-seeds", "AGB-004", "claim-evidence-table.json"),
      "utf8"
    );
    expect(claimEvidence).toContain("claim_hallucinated_related_work_support");
  });
});
