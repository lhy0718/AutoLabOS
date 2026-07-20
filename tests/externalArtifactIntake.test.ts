import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { runPaperReadinessAudit } from "../src/core/audit/paperReadinessAudit.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("external artifact audit intake", () => {
  it("copies only allowlisted external artifacts and omits machine-local source paths", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-external-audit-workspace-"));
    const external = await mkdtemp(path.join(os.tmpdir(), "autolabos-external-audit-source-"));
    tempDirs.push(workspace, external);

    await mkdir(path.join(external, "paper"), { recursive: true });
    await mkdir(path.join(external, "figure_audit"), { recursive: true });
    await mkdir(path.join(external, "secret"), { recursive: true });
    await writeFile(path.join(external, "governance_condition.json"), JSON.stringify({ name: "gated" }), "utf8");
    await writeFile(
      path.join(external, "result_table.json"),
      JSON.stringify([{ metric: "accuracy", baseline: 0.7, comparator: 0.74, delta: 0.04, direction: "higher_better" }]),
      "utf8"
    );
    await writeFile(path.join(external, "evidence_store.jsonl"), JSON.stringify({ id: "ev_metric", metric: "accuracy", value: 0.74 }) + "\n", "utf8");
    await writeFile(
      path.join(external, "paper", "claim_evidence_table.json"),
      JSON.stringify({
        claims: [{
          claim_id: "claim_accuracy_delta",
          statement: "The method improves accuracy in this run.",
          section_heading: "Results",
          artifact_refs: ["result_table.json"],
          citation_refs: [],
          evidence_ids: ["ev_metric"]
        }]
      }),
      "utf8"
    );
    await writeFile(
      path.join(external, "paper", "claim_status_table.json"),
      JSON.stringify({
        claims: [{
          claim_id: "claim_accuracy_delta",
          statement: "The method improves accuracy in this run.",
          section_heading: "Results",
          status: "verified",
          artifact_refs: ["result_table.json"],
          citation_refs: [],
          reproduction_trace_present: true
        }]
      }),
      "utf8"
    );
    await writeFile(
      path.join(external, "paper", "evidence_links.json"),
      JSON.stringify({ claims: [{ claim_id: "claim_accuracy_delta", artifact_refs: ["result_table.json"], evidence_ids: ["ev_metric"] }] }),
      "utf8"
    );
    await writeFile(path.join(external, "paper", "paper_readiness.json"), JSON.stringify({ paper_ready: false, readiness_state: "research_memo" }), "utf8");
    await writeFile(path.join(external, "figure_audit", "figure_audit_summary.json"), JSON.stringify({ severe_mismatch_count: 0, review_block_required: false, issues: [] }), "utf8");
    await writeFile(path.join(external, "secret", "notes.txt"), "do not copy", "utf8");
    const draftPath = path.join(external, "draft.md");
    const logPath = path.join(external, "run.log");
    await writeFile(draftPath, "# Draft\n", "utf8");
    await writeFile(logPath, "ran\n", "utf8");

    const summary = await runPaperReadinessAudit({
      cwd: workspace,
      externalRoot: external,
      draftPath,
      logPath,
      outDir: "outputs/audit-external"
    });

    expect(summary.input.mode).toBe("external");
    expect(summary.input.run_root).toBe("outputs/audit-external/_external-intake/run-artifacts");
    expect(summary.outputs.external_intake_manifest_path).toBe("outputs/audit-external/external-intake-manifest.json");
    expect(summary.outputs.claim_evidence_path).toBe("outputs/audit-external/claim-evidence-table.json");

    const manifestRaw = await readFile(path.join(workspace, "outputs", "audit-external", "external-intake-manifest.json"), "utf8");
    expect(manifestRaw).not.toContain(external);
    expect(manifestRaw).toContain("<external-artifact-root>");
    expect(manifestRaw).not.toContain("secret/notes.txt");
    expect(manifestRaw).toContain("paper/draft.md");
    expect(manifestRaw).toContain("logs/external.log");
    const manifest = JSON.parse(manifestRaw) as {
      copied_files: string[];
      copied_file_bindings: Array<{ path: string; sha256: string; bytes: number }>;
      copied_file_mappings: Array<{
        source_ref: string;
        copied_path: string;
        sha256: string;
        bytes: number;
      }>;
    };
    expect(manifest.copied_file_bindings.map((binding) => binding.path)).toEqual(manifest.copied_files);
    expect(manifest.copied_file_bindings.every(
      (binding) => /^[a-f0-9]{64}$/u.test(binding.sha256) && binding.bytes > 0
    )).toBe(true);
    expect(manifest.copied_file_mappings).toContainEqual(expect.objectContaining({
      source_ref: "<explicit-draft>",
      copied_path: "paper/draft.md"
    }));

    const claimExport = await readFile(path.join(workspace, "outputs", "audit-external", "claim-evidence-table.json"), "utf8");
    expect(claimExport).toContain("claim_accuracy_delta");
    expect(claimExport).toContain("artifact_or_citation_linked");
  });

  it("normalizes a root academic package and audits its submission and reference gates", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-academic-audit-workspace-"));
    const external = await mkdtemp(path.join(os.tmpdir(), "autolabos-academic-audit-source-"));
    tempDirs.push(workspace, external);

    await writeFile(path.join(external, "manuscript.tex"), "\\section{Method}\n", "utf8");
    await writeFile(path.join(external, "references.bib"), "@article{source_a,title={Source A}}\n", "utf8");
    await writeFile(path.join(external, "claim-evidence-map.json"), JSON.stringify({
      schema_version: "1.0",
      claim_ceiling: "development_validation",
      claims: [
        {
          claim_id: "contract-claim",
          claim: "The validator enforces the declared contract.",
          status: "supported_by_code_and_tests",
          artifact_refs: ["src/validator.ts", "tests/validator.test.ts"]
        },
        {
          claim_id: "effect-claim",
          claim: "The policy generalizes to held-out evidence.",
          status: "blocked",
          missing_evidence: [
            "real_provider_trials",
            "source_license_review",
            "double_adjudicated_labels"
          ]
        }
      ]
    }), "utf8");
    await writeFile(path.join(external, "reference-evidence-status.json"), JSON.stringify({
      schema_version: "1.0",
      submission_gate_passed: false,
      summary: {
        citation_bearing_claim_count: 2,
        full_text_evidence_candidate_count: 1,
        independently_checked_claim_count: 0,
        missing_full_text_claim_count: 1
      },
      sources: []
    }), "utf8");
    await writeFile(path.join(external, "submission-status.json"), JSON.stringify({
      schema_version: "1.0",
      paper_ready: false,
      manuscript_type: "research_memo",
      blocking_requirements: [
        "full_text_source_missing",
        "completed_independent_review",
        "independent_review_of_full_text_evidence",
        "real_provider_trials",
        "official_template_revalidation"
      ]
    }), "utf8");
    const claimHeader = [
      "claim_id", "manuscript_location", "claim_text", "citation_key", "source_location",
      "quote_or_evidence", "evidence_kind", "status", "notes", "claim_type", "importance"
    ];
    const claimRows = [
      ["claim-a", "line 10", "Prior system A enforces a gate.", "source_a", "page 1", "support", "source_text", "needs_review", "review required", "related_work", "normal"],
      ["claim-b", "line 11", "Prior system B preserves evidence.", "source_b", "", "", "", "claim_unchecked", "full text missing", "related_work", "normal"]
    ];
    await writeFile(
      path.join(external, "refgate_claims.tsv"),
      [claimHeader, ...claimRows].map((row) => row.join("\t")).join("\n") + "\n",
      "utf8"
    );

    const summary = await runPaperReadinessAudit({
      cwd: workspace,
      externalRoot: external,
      outDir: "outputs/academic-audit"
    });

    expect(summary.verdict).toBe("blocked");
    expect(summary.citation_support_issues).toHaveLength(2);
    expect(summary.citation_support_issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ claim_id: "claim-a", target_node: "analyze_papers" }),
      expect.objectContaining({ claim_id: "claim-b", target_node: "collect_papers" })
    ]));
    expect(summary.unsupported_claims).not.toContainEqual(expect.objectContaining({
      claim_id: "effect-claim"
    }));
    expect(summary.research_scale_findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "reference_full_text_missing", target_node: "collect_papers" }),
      expect.objectContaining({ code: "reference_claim_review_incomplete", target_node: "analyze_papers" }),
      expect.objectContaining({ code: "academic_claim_evidence_blocked:effect-claim:run_experiments", target_node: "run_experiments" }),
      expect.objectContaining({ code: "academic_claim_evidence_blocked:effect-claim:collect_papers", target_node: "collect_papers" }),
      expect.objectContaining({ code: "academic_claim_evidence_blocked:effect-claim:review", target_node: "review" }),
      expect.objectContaining({ code: "submission_requirements_open:analyze_papers", target_node: "analyze_papers" }),
      expect.objectContaining({ code: "submission_requirements_open:write_paper", target_node: "write_paper" })
    ]));

    const manifest = JSON.parse(await readFile(
      path.join(workspace, "outputs", "academic-audit", "external-intake-manifest.json"),
      "utf8"
    )) as {
      copied_files: string[];
      copied_file_bindings: Array<{ path: string; sha256: string; bytes: number }>;
      copied_file_mappings: Array<{
        source_ref: string;
        copied_path: string;
        sha256: string;
        bytes: number;
      }>;
    };
    expect(manifest.copied_files).toEqual(expect.arrayContaining([
      "paper/main.tex",
      "paper/references.bib",
      "paper/academic_claim_evidence_map.json",
      "paper/reference_evidence_status.json",
      "paper/submission_status.json",
      "paper/refgate_claims.tsv"
    ]));
    expect(manifest.copied_file_bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "paper/main.tex",
        sha256: createHash("sha256").update("\\section{Method}\n").digest("hex")
      })
    ]));
    expect(manifest.copied_file_mappings).toContainEqual(expect.objectContaining({
      source_ref: "manuscript.tex",
      copied_path: "paper/main.tex",
      sha256: createHash("sha256").update("\\section{Method}\n").digest("hex")
    }));
    expect(JSON.stringify(manifest)).not.toContain(external);
  });

  it("fails closed when an academic package contains a malformed claim inventory", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "autolabos-academic-invalid-workspace-"));
    const external = await mkdtemp(path.join(os.tmpdir(), "autolabos-academic-invalid-source-"));
    tempDirs.push(workspace, external);
    await writeFile(path.join(external, "refgate_claims.tsv"), "claim_id\tstatus\nclaim-a\tneeds_review\n", "utf8");

    const summary = await runPaperReadinessAudit({
      cwd: workspace,
      externalRoot: external,
      outDir: "outputs/academic-invalid-audit"
    });

    expect(summary.verdict).toBe("blocked");
    expect(summary.research_scale_findings).toContainEqual(expect.objectContaining({
      code: "reference_claim_inventory_invalid",
      target_node: "analyze_papers"
    }));
  });
});
