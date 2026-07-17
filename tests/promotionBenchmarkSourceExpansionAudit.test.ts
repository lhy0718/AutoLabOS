import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PROMOTION_SOURCE_EXPANSION_STAGES,
  auditPromotionSourceExpansion,
  evaluatePromotionSourceExpansion,
  type PromotionSourceExpansionEvidenceBasis,
  type PromotionSourceExpansionInventory,
  type PromotionSourceExpansionObservation,
  type PromotionSourceExpansionRoute
} from "../src/core/benchmark/promotionBenchmarkSourceExpansionAudit.js";

describe("promotion source expansion audit", () => {
  it("separates observed route capacity from exact confirmatory admission", () => {
    const inventory = makeInventory([
      makeRoute("route-alpha", {
        discovered_candidates: observation(80, "exact_artifact_count"),
        source_hash_bound: observation(20, "exact_artifact_count"),
        real_execution_trace_observed: observation(50, "bounded_lower_bound")
      })
    ]);

    const report = evaluatePromotionSourceExpansion(inventory);

    expect(report).toMatchObject({
      status: "blocked_for_paper_scale",
      exact_confirmatory_admitted_count: 0,
      remaining_base_bundle_gap: 72,
      paper_scale_source_ready: false
    });
    expect(stage(report, "discovered_candidates")).toMatchObject({
      exact_artifact_count: 80,
      established_floor: 80
    });
    expect(stage(report, "real_execution_trace_observed")).toMatchObject({
      bounded_lower_bound_count: 50,
      established_floor: 50
    });
    expect(report.node_recommendations.map((item) => item.node)).toEqual(expect.arrayContaining([
      "collect_papers",
      "run_experiments",
      "analyze_results",
      "review",
      "design_experiments"
    ]));
  });

  it("does not count reported admission claims as exact admitted evidence", () => {
    const route = completeRoute("route-alpha", 72, "family-alpha", "operator-alpha");
    route.stages.confirmatory_admitted = observation(72, "reported_claim");
    const report = evaluatePromotionSourceExpansion(makeInventory([route]));

    expect(report.exact_confirmatory_admitted_count).toBe(0);
    expect(report.issues.map((issue) => issue.code)).toContain("confirmatory_admission_not_exact");
    expect(report.paper_scale_source_ready).toBe(false);
  });

  it("passes only an exact, balanced, evidence-complete 72-base inventory", () => {
    const report = evaluatePromotionSourceExpansion(makeInventory([
      completeRoute("route-alpha", 24, "family-alpha", "operator-alpha"),
      completeRoute("route-beta", 24, "family-beta", "operator-beta"),
      completeRoute("route-gamma", 24, "family-gamma", "operator-gamma")
    ]));

    expect(report).toMatchObject({
      status: "paper_scale_source_ready",
      paper_scale_source_ready: true,
      exact_confirmatory_admitted_count: 72,
      remaining_base_bundle_gap: 0,
      admitted_source_family_count: 3,
      admitted_operator_group_count: 3
    });
    expect(report.issues).toEqual([]);
    expect(report.node_recommendations).toEqual([]);
  });

  it("rejects an admitted inventory concentrated in one source family", () => {
    const report = evaluatePromotionSourceExpansion(makeInventory([
      completeRoute("route-alpha", 24, "family-shared", "operator-alpha"),
      completeRoute("route-beta", 24, "family-shared", "operator-beta"),
      completeRoute("route-gamma", 24, "family-shared", "operator-gamma")
    ]));

    expect(report.paper_scale_source_ready).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "admitted_source_family_minimum_not_met",
      "admitted_source_family_share_exceeded"
    ]));
  });

  it("blocks duplicate admitted bundle hashes across source routes", () => {
    const first = completeRoute("route-alpha", 24, "family-alpha", "operator-alpha");
    const second = completeRoute("route-beta", 24, "family-beta", "operator-beta");
    const third = completeRoute("route-gamma", 24, "family-gamma", "operator-gamma");
    second.admitted_bundles[0] = { ...first.admitted_bundles[0] };

    const report = evaluatePromotionSourceExpansion(makeInventory([first, second, third]));

    expect(report.paper_scale_source_ready).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("confirmatory_admitted_bundle_hash_duplicate");
  });

  it("blocks an exact admission backed by a reported upstream stage", () => {
    const routes = [
      completeRoute("route-alpha", 24, "family-alpha", "operator-alpha"),
      completeRoute("route-beta", 24, "family-beta", "operator-beta"),
      completeRoute("route-gamma", 24, "family-gamma", "operator-gamma")
    ];
    routes[0].stages.explicit_readiness_observed = observation(24, "reported_claim");

    const report = evaluatePromotionSourceExpansion(makeInventory(routes));

    expect(report.paper_scale_source_ready).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("confirmatory_admitted_upstream_stage_not_exact");
  });

  it("writes a portable machine-readable report and summary", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "source-expansion-audit-"));
    const inventory = makeInventory([makeRoute("route-alpha", {
      discovered_candidates: observation(12, "exact_artifact_count")
    })]);
    await writeFile(path.join(workspace, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`, "utf8");

    const result = await auditPromotionSourceExpansion({
      cwd: workspace,
      inventoryPath: "inventory.json",
      outDir: "audit"
    });

    expect(result.report_path).toBe("audit/promotion-source-expansion-audit.json");
    expect(result.summary_path).toBe("audit/promotion-source-expansion-audit.md");
    expect(JSON.parse(await readFile(path.join(workspace, result.report_path), "utf8"))).toMatchObject({
      exact_confirmatory_admitted_count: 0,
      remaining_base_bundle_gap: 72
    });
    expect(await readFile(path.join(workspace, result.summary_path), "utf8")).toContain("Evidence Ladder");
  });

  it("rejects local absolute paths in route evidence references", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "source-expansion-audit-"));
    const inventory = makeInventory([makeRoute("route-alpha")]);
    inventory.routes[0].stages.confirmatory_admitted = {
      count: 0,
      basis: "exact_artifact_count",
      evidence_refs: [path.join(workspace, "private.json")],
      note: "Local-only evidence must not enter a public inventory."
    };
    await writeFile(path.join(workspace, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`, "utf8");

    await expect(auditPromotionSourceExpansion({
      cwd: workspace,
      inventoryPath: "inventory.json",
      outDir: "audit"
    })).rejects.toThrow("Invalid promotion source stage observation");
  });
});

function makeInventory(routes: PromotionSourceExpansionRoute[]): PromotionSourceExpansionInventory {
  return {
    schema_version: "1.0",
    study_id: "study-neutral",
    inventory_revision: "revision-neutral",
    routes,
    evidence_boundary: "Route observations are not confirmatory admissions."
  };
}

function makeRoute(
  routeId: string,
  overrides: Partial<Record<typeof PROMOTION_SOURCE_EXPANSION_STAGES[number], PromotionSourceExpansionObservation>> = {}
): PromotionSourceExpansionRoute {
  const stages = Object.fromEntries(PROMOTION_SOURCE_EXPANSION_STAGES.map((stageName) => [
    stageName,
    overrides[stageName] || unknownObservation()
  ])) as PromotionSourceExpansionRoute["stages"];
  stages.confirmatory_admitted = overrides.confirmatory_admitted || observation(0, "exact_artifact_count");
  return {
    route_id: routeId,
    source_revision: "revision-neutral",
    source_url: `https://example.org/${routeId}`,
    selection_policy: "Outcome-blind lexical selection.",
    stages,
    admitted_bundles: [],
    blockers: ["independent_normalization_pending"]
  };
}

function completeRoute(
  routeId: string,
  count: number,
  familyId: string,
  operatorId: string
): PromotionSourceExpansionRoute {
  const route = makeRoute(routeId);
  for (const stageName of PROMOTION_SOURCE_EXPANSION_STAGES) {
    route.stages[stageName] = observation(count, "exact_artifact_count");
  }
  route.admitted_bundles = Array.from({ length: count }, (_, index) => ({
    base_bundle_sha256: createHash("sha256").update(`${routeId}:${index}`).digest("hex"),
    source_family_id: familyId,
    operator_group_id: operatorId,
    admission_evidence_ref: "evidence/confirmatory-intake.json"
  }));
  route.blockers = [];
  return route;
}

function observation(
  count: number,
  basis: Exclude<PromotionSourceExpansionEvidenceBasis, "not_established">
): PromotionSourceExpansionObservation {
  return {
    count,
    basis,
    evidence_refs: ["evidence/route-audit.json"],
    note: "Count is bound to the declared evidence reference."
  };
}

function unknownObservation(): PromotionSourceExpansionObservation {
  return {
    count: null,
    basis: "not_established",
    evidence_refs: [],
    note: "This stage has not been established."
  };
}

function stage(
  report: ReturnType<typeof evaluatePromotionSourceExpansion>,
  stageName: typeof PROMOTION_SOURCE_EXPANSION_STAGES[number]
) {
  return report.stage_summaries.find((item) => item.stage === stageName);
}
