import os from "node:os";
import path from "node:path";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { buildPromotionBenchmarkSuite } from "../src/core/benchmark/promotionBenchmarkBuilder.js";
import {
  exportPromotionMutationAuditPack,
  validateVerifiedPromotionMutationAuditReport,
  verifyPromotionMutationAudit
} from "../src/core/benchmark/promotionBenchmarkMutationAudit.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("promotion benchmark mutation isolation audit", () => {
  it("exports paired mutation tasks without promotion labels and accepts two isolated audits", async () => {
    const workspace = await createWorkspace();
    const exported = await exportPromotionMutationAuditPack({
      cwd: workspace,
      suitePath: "suite/suite.json",
      outDir: "mutation-audit-pack"
    });

    expect(exported.audit_count).toBe(1);
    expect(exported.tasks_path).toContain("mutation-audit-pack/mutation-auditor/");
    expect(exported.private_map_path).toBe("mutation-audit-pack/private-mutation-audit-map.json");
    await expect(access(path.join(workspace, exported.auditor_dir, "private-mutation-audit-map.json"))).rejects.toThrow();

    const tasksText = await readFile(path.join(workspace, exported.tasks_path), "utf8");
    expect(tasksText).toMatch(/mutation_family|declared_operations|clean_artifact_root|mutated_artifact_root/iu);
    expect(tasksText).not.toMatch(/case-clean|case-fault|"gold"|system_prediction|promotion_label/iu);
    const tasks = parseTasks(tasksText);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      clean_artifact_root: expect.stringContaining("/clean"),
      mutated_artifact_root: expect.stringContaining("/mutated"),
      allowed_decisions: ["isolated", "confounded"]
    });

    await writeAudits(workspace, "audit-a.jsonl", tasks, "auditor-alpha");
    await writeAudits(workspace, "audit-b.jsonl", tasks, "auditor-beta");
    const verified = await verifyPromotionMutationAudit({
      cwd: workspace,
      suitePath: "suite/suite.json",
      privateMapPath: exported.private_map_path,
      auditPaths: ["audit-a.jsonl", "audit-b.jsonl"],
      outDir: "mutation-verification"
    });

    expect(verified.report).toMatchObject({
      passed: true,
      mutation_isolation_status: "double_verified",
      auditor_ids: ["auditor-alpha", "auditor-beta"],
      case_count: 1,
      verified_case_count: 1,
      confounded_case_count: 0,
      validation_issues: []
    });
    const validation = await validateVerifiedPromotionMutationAuditReport({
      reportPath: path.join(workspace, verified.report_path),
      suitePath: path.join(workspace, "suite", "suite.json"),
      suiteId: "mutation-audit-suite",
      cases: await suiteCases(workspace)
    });
    expect(validation).toEqual({
      verified: true,
      issues: [],
      auditor_ids: ["auditor-alpha", "auditor-beta"]
    });

    const decision = JSON.parse(await readFile(
      path.join(workspace, "mutation-verification", "review", "decision.json"),
      "utf8"
    )) as Record<string, unknown>;
    expect(decision).toMatchObject({ outcome: "accept", mutation_isolation_status: "double_verified" });
  });

  it("blocks a confounded mutation and routes repair to experiment design", async () => {
    const workspace = await createWorkspace();
    const exported = await exportPromotionMutationAuditPack({ cwd: workspace, suitePath: "suite/suite.json", outDir: "audit-pack" });
    const tasks = parseTasks(await readFile(path.join(workspace, exported.tasks_path), "utf8"));
    await writeAudits(workspace, "audit-a.jsonl", tasks, "auditor-alpha", "confounded");
    await writeAudits(workspace, "audit-b.jsonl", tasks, "auditor-beta");

    const result = await verifyPromotionMutationAudit({
      cwd: workspace,
      suitePath: "suite/suite.json",
      privateMapPath: exported.private_map_path,
      auditPaths: ["audit-a.jsonl", "audit-b.jsonl"],
      outDir: "confounded-verification"
    });
    expect(result.report).toMatchObject({
      passed: false,
      mutation_isolation_status: "unreviewed",
      confounded_case_count: 1,
      disagreement_count: 1
    });
    const recommendations = JSON.parse(await readFile(
      path.join(workspace, "confounded-verification", "review", "node_strengthening_recommendations.json"),
      "utf8"
    )) as { recommendations: Array<{ node: string }> };
    expect(recommendations.recommendations).toContainEqual(expect.objectContaining({ node: "design_experiments" }));
  });

  it("fails closed when auditors are not independent or coverage is incomplete", async () => {
    const workspace = await createWorkspace();
    const exported = await exportPromotionMutationAuditPack({ cwd: workspace, suitePath: "suite/suite.json", outDir: "audit-pack" });
    const tasks = parseTasks(await readFile(path.join(workspace, exported.tasks_path), "utf8"));
    await writeAudits(workspace, "audit-a.jsonl", tasks, "auditor-shared");
    await writeFile(path.join(workspace, "audit-b.jsonl"), "", "utf8");

    const result = await verifyPromotionMutationAudit({
      cwd: workspace,
      suitePath: "suite/suite.json",
      privateMapPath: exported.private_map_path,
      auditPaths: ["audit-a.jsonl", "audit-b.jsonl"],
      outDir: "invalid-verification"
    });
    expect(result.report.passed).toBe(false);
    expect(result.report.validation_issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "mutation_audit_file_identity_invalid",
      "mutation_audit_coverage_incomplete",
      "mutation_auditors_not_independent"
    ]));
    const recommendations = JSON.parse(await readFile(
      path.join(workspace, "invalid-verification", "review", "node_strengthening_recommendations.json"),
      "utf8"
    )) as { recommendations: Array<{ node: string }> };
    expect(recommendations.recommendations).toContainEqual(expect.objectContaining({ node: "review" }));
  });

  it("detects suite-map drift before accepting auditor records", async () => {
    const workspace = await createWorkspace();
    const exported = await exportPromotionMutationAuditPack({ cwd: workspace, suitePath: "suite/suite.json", outDir: "audit-pack" });
    const tasks = parseTasks(await readFile(path.join(workspace, exported.tasks_path), "utf8"));
    await writeAudits(workspace, "audit-a.jsonl", tasks, "auditor-alpha");
    await writeAudits(workspace, "audit-b.jsonl", tasks, "auditor-beta");
    const mapPath = path.join(workspace, exported.private_map_path);
    const privateMap = JSON.parse(await readFile(mapPath, "utf8")) as Record<string, unknown>;
    privateMap.suite_id = "different-suite";
    await writeFile(mapPath, `${JSON.stringify(privateMap, null, 2)}\n`, "utf8");

    const result = await verifyPromotionMutationAudit({
      cwd: workspace,
      suitePath: "suite/suite.json",
      privateMapPath: exported.private_map_path,
      auditPaths: ["audit-a.jsonl", "audit-b.jsonl"],
      outDir: "drift-verification"
    });
    expect(result.report.passed).toBe(false);
    expect(result.report.validation_issues.map((issue) => issue.code)).toContain("mutation_audit_map_suite_mismatch");
  });

  it("rejects a hand-edited verified report whose aggregates no longer match its traces", async () => {
    const workspace = await createWorkspace();
    const exported = await exportPromotionMutationAuditPack({ cwd: workspace, suitePath: "suite/suite.json", outDir: "audit-pack" });
    const tasks = parseTasks(await readFile(path.join(workspace, exported.tasks_path), "utf8"));
    await writeAudits(workspace, "audit-a.jsonl", tasks, "auditor-alpha");
    await writeAudits(workspace, "audit-b.jsonl", tasks, "auditor-beta");
    const result = await verifyPromotionMutationAudit({
      cwd: workspace,
      suitePath: "suite/suite.json",
      privateMapPath: exported.private_map_path,
      auditPaths: ["audit-a.jsonl", "audit-b.jsonl"],
      outDir: "verified"
    });
    const reportPath = path.join(workspace, result.report_path);
    const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
    report.verified_case_count = 0;
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    const validation = await validateVerifiedPromotionMutationAuditReport({
      reportPath,
      suitePath: path.join(workspace, "suite", "suite.json"),
      suiteId: "mutation-audit-suite",
      cases: await suiteCases(workspace)
    });
    expect(validation.verified).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toContain("mutation_isolation_report_aggregate_mismatch");

    report.verified_case_count = 1;
    const caseResults = report.case_results as Array<{ binding: { mutation_manifest_sha256: string } }>;
    caseResults[0].binding.mutation_manifest_sha256 = "0".repeat(64);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const bindingValidation = await validateVerifiedPromotionMutationAuditReport({
      reportPath,
      suitePath: path.join(workspace, "suite", "suite.json"),
      suiteId: "mutation-audit-suite",
      cases: await suiteCases(workspace)
    });
    expect(bindingValidation.verified).toBe(false);
    expect(bindingValidation.issues.map((issue) => issue.code)).toContain("mutation_isolation_case_binding_mismatch");
  });
});

interface MutationAuditTask {
  audit_id: string;
  clean_artifact_root: string;
  mutated_artifact_root: string;
  allowed_decisions: string[];
}

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "promotion-mutation-audit-"));
  tempDirs.push(workspace);
  await mkdir(path.join(workspace, "bundle"), { recursive: true });
  await writeFile(
    path.join(workspace, "bundle", "result_table.json"),
    '{"rows":[{"metric":"primary_score","baseline":0.5,"candidate":0.6}]}\n',
    "utf8"
  );
  await writeFile(path.join(workspace, "recipe.json"), `${JSON.stringify({
    schema_version: "1.0",
    suite_id: "mutation-audit-suite",
    evidence_class: "external_real_run",
    paper_claim_eligible: false,
    adjudication_status: "unreviewed",
    mutation_isolation_status: "unreviewed",
    cases: [
      {
        case_id: "case-clean",
        base_bundle_id: "base-alpha",
        split: "test",
        source_root: "bundle",
        operations: [],
        gold: { decision: "promote", blocking_concerns: [], repair_owners: [] }
      },
      {
        case_id: "case-fault",
        base_bundle_id: "base-alpha",
        split: "test",
        source_root: "bundle",
        mutation_family: "comparison_evidence_gap",
        operations: [{ op: "remove_json_pointer", path: "result_table.json", pointer: "/rows/0/candidate" }],
        gold: { decision: "needs_review", blocking_concerns: [], repair_owners: [] }
      }
    ]
  }, null, 2)}\n`, "utf8");
  await buildPromotionBenchmarkSuite({ cwd: workspace, recipePath: "recipe.json", outDir: "suite" });
  return workspace;
}

function parseTasks(text: string): MutationAuditTask[] {
  return text.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as MutationAuditTask);
}

async function writeAudits(
  workspace: string,
  fileName: string,
  tasks: MutationAuditTask[],
  auditorId: string,
  decision: "isolated" | "confounded" = "isolated"
): Promise<void> {
  const rows = tasks.map((task) => JSON.stringify({
    schema_version: "1.0",
    audit_id: task.audit_id,
    auditor_id: auditorId,
    audit_source: "human",
    decision,
    additional_faults: decision === "confounded" ? ["additional_artifact_change"] : [],
    rationale: decision === "confounded"
      ? "The pair contains an additional change outside the declared operation."
      : "The observed difference is limited to the declared operation."
  }));
  await writeFile(path.join(workspace, fileName), `${rows.join("\n")}\n`, "utf8");
}

async function suiteCases(workspace: string) {
  const clean = JSON.parse(await readFile(path.join(workspace, "suite", "cases", "case-clean.json"), "utf8"));
  const fault = JSON.parse(await readFile(path.join(workspace, "suite", "cases", "case-fault.json"), "utf8"));
  return [clean, fault];
}
