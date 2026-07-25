import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { repairPromotionArtifacts } from "../src/core/nodes/promotionArtifactRepairAdapters.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("promotion artifact repair adapters", () => {
  it("restores only claim-bound valid evidence ids during analyze_results repair", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "promotion-repair-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "paper"), { recursive: true });
    await writeJson(path.join(root, "design_contracts.json"), {
      sota_ranking_claimed: false,
      sota_evidence_present: false
    });
    await writeJson(path.join(root, "result_table.json"), [{
      metric: "primary_metric",
      baseline: 0.4,
      comparator: 0.5,
      delta: 0.1
    }]);
    const claim = { claim_id: "claim-primary", artifact_refs: [] };
    await writeJson(path.join(root, "paper", "claim_evidence_table.json"), { claims: [claim] });
    await writeJson(path.join(root, "paper", "claim_status_table.json"), { claims: [claim] });
    await writeJson(path.join(root, "paper", "evidence_links.json"), {
      claims: [{ claim_id: "claim-primary", evidence_ids: [], citation_paper_ids: [] }]
    });
    await fs.writeFile(path.join(root, "evidence_store.jsonl"), [
      JSON.stringify({
        id: "evidence-valid",
        claim_id: "claim-primary",
        claim_evidence_valid: true,
        artifact_refs: ["result_table.json"]
      }),
      JSON.stringify({
        id: "evidence-other-claim",
        claim_id: "claim-other",
        claim_evidence_valid: true,
        artifact_refs: ["result_table.json"]
      }),
      JSON.stringify({
        id: "evidence-unvalidated",
        claim_id: "claim-primary",
        claim_evidence_valid: false,
        artifact_refs: ["result_table.json"]
      }),
      ""
    ].join("\n"), "utf8");

    const result = await repairPromotionArtifacts({ artifactRoot: root, owner: "analyze_results" });

    expect(result).toMatchObject({
      adapter_revision: "promotion-artifact-repair-v2",
      changed_paths: [
        "paper/claim_evidence_table.json",
        "paper/claim_status_table.json",
        "paper/evidence_links.json"
      ]
    });
    const links = JSON.parse(await fs.readFile(
      path.join(root, "paper", "evidence_links.json"),
      "utf8"
    )) as { claims: Array<{ evidence_ids: string[]; citation_paper_ids: string[] }> };
    expect(links.claims[0].evidence_ids).toEqual(["evidence-valid"]);
    expect(links.claims[0].citation_paper_ids).toEqual([]);
  });
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
