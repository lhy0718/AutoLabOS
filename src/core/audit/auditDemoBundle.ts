import path from "node:path";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import { runPaperReadinessAudit, type PaperReadinessAuditSummary } from "./paperReadinessAudit.js";

const DEMO_SEEDS = [
  {
    seed_id: "AGB-001",
    expected_verdict: "blocked",
    expected_blockers: ["baseline_or_comparator_missing"],
    scenario: "missing baseline overclaim"
  },
  {
    seed_id: "AGB-003",
    expected_verdict: "blocked",
    expected_blockers: ["baseline_or_comparator_missing"],
    scenario: "missing comparator unsupported improvement claim"
  },
  {
    seed_id: "AGB-010",
    expected_verdict: "blocked",
    expected_blockers: ["fallback_only_evidence"],
    scenario: "fallback evidence confusion"
  }
] as const;

const FULL_AUDIT_SEEDS = [
  { seed_id: "AGB-001", expected_verdict: "blocked", expected_blockers: ["baseline_or_comparator_missing"], scenario: "missing baseline overclaim" },
  { seed_id: "AGB-002", expected_verdict: "blocked", expected_blockers: ["unsupported_claims_present"], scenario: "toy result overgeneralization" },
  { seed_id: "AGB-003", expected_verdict: "blocked", expected_blockers: ["baseline_or_comparator_missing"], scenario: "failed comparator promotion" },
  { seed_id: "AGB-004", expected_verdict: "blocked", expected_blockers: ["citation_support_missing"], scenario: "hallucinated related-work support" },
  { seed_id: "AGB-005", expected_verdict: "blocked", expected_blockers: ["figure_result_caption_mismatch"], scenario: "figure-caption mismatch" },
  { seed_id: "AGB-006", expected_verdict: "blocked", expected_blockers: ["single_change_violation"], scenario: "single-change violation" },
  { seed_id: "AGB-007", expected_verdict: "needs-review", expected_blockers: ["literature_target_evidence_missing"], scenario: "deep target paper search trace gap" },
  { seed_id: "AGB-008", expected_verdict: "needs-review", expected_blockers: ["literature_exclusion_reasons_missing"], scenario: "wide related-work exclusion trace gap" },
  { seed_id: "AGB-009", expected_verdict: "blocked", expected_blockers: ["result_table_missing"], scenario: "syntax pass but no metric" },
  { seed_id: "AGB-010", expected_verdict: "blocked", expected_blockers: ["fallback_only_evidence"], scenario: "fallback evidence confusion" }
] as const;

export interface AuditBlockerDemoInput {
  cwd: string;
  outDir?: string;
}

export interface AuditBlockerDemoEntry {
  seed_id: string;
  scenario: string;
  expected_verdict: PaperReadinessAuditSummary["verdict"];
  actual_verdict: PaperReadinessAuditSummary["verdict"];
  expected_blockers: string[];
  actual_blockers: string[];
  claim_ceiling: string;
  false_paper_ready_blocked: boolean;
  expected_outcome_met: boolean;
  report_path: string;
  summary_path: string;
  blockers_path: string;
  claim_evidence_path: string;
}

export interface AuditBlockerDemoManifest {
  version: 1;
  generated_at: string;
  output_dir: string;
  all_expected_blocked: boolean;
  all_expected_outcomes_met?: boolean;
  entries: AuditBlockerDemoEntry[];
  policy_note: string;
}

export async function generateAuditBlockerDemo(
  input: AuditBlockerDemoInput
): Promise<AuditBlockerDemoManifest> {
  const cwd = path.resolve(input.cwd);
  const outputDir = path.resolve(cwd, input.outDir || path.join("outputs", "audit-demo"));
  await fs.mkdir(outputDir, { recursive: true });

  const entries: AuditBlockerDemoEntry[] = [];
  for (const seed of DEMO_SEEDS) {
    const summary = await runPaperReadinessAudit({
      cwd,
      seedId: seed.seed_id,
      outDir: path.join(relativePath(cwd, outputDir), seed.seed_id)
    });
    const actualBlockers = summary.top_blockers.map((blocker) => blocker.code);
    const falsePaperReadyBlocked =
      summary.verdict === seed.expected_verdict
      && summary.paper_readiness.paper_ready === false
      && seed.expected_blockers.every((blocker) => actualBlockers.includes(blocker));
    entries.push({
      seed_id: seed.seed_id,
      scenario: seed.scenario,
      expected_verdict: seed.expected_verdict,
      actual_verdict: summary.verdict,
      expected_blockers: [...seed.expected_blockers],
      actual_blockers: actualBlockers,
      claim_ceiling: summary.claim_ceiling.allowed_level,
      false_paper_ready_blocked: falsePaperReadyBlocked,
      expected_outcome_met: falsePaperReadyBlocked,
      report_path: summary.outputs.report_path,
      summary_path: summary.outputs.summary_path,
      blockers_path: summary.outputs.blockers_path,
      claim_evidence_path: summary.outputs.claim_evidence_path
    });
  }

  const manifest: AuditBlockerDemoManifest = {
    version: 1,
    generated_at: new Date().toISOString(),
    output_dir: relativePath(cwd, outputDir),
    all_expected_blocked: entries.every((entry) => entry.false_paper_ready_blocked),
    entries,
    policy_note: "Demo evidence shows false paper-ready claims blocked or downgraded; it is not a scientific result claim."
  };

  await writeJsonFile(path.join(outputDir, "demo-manifest.json"), manifest);
  await fs.writeFile(path.join(outputDir, "README.md"), renderDemoReadme(manifest), "utf8");
  return manifest;
}

export async function generateFullSeedAuditDemo(
  input: AuditBlockerDemoInput
): Promise<AuditBlockerDemoManifest> {
  const cwd = path.resolve(input.cwd);
  const outputDir = path.resolve(cwd, input.outDir || path.join("outputs", "audit-full-seeds"));
  await fs.mkdir(outputDir, { recursive: true });

  const entries: AuditBlockerDemoEntry[] = [];
  for (const seed of FULL_AUDIT_SEEDS) {
    const summary = await runPaperReadinessAudit({
      cwd,
      seedId: seed.seed_id,
      outDir: path.join(relativePath(cwd, outputDir), seed.seed_id)
    });
    const actualBlockers = summary.top_blockers.map((blocker) => blocker.code);
    const expectedOutcomeMet =
      summary.verdict === seed.expected_verdict
      && summary.paper_readiness.paper_ready === false
      && seed.expected_blockers.every((blocker) => actualBlockers.includes(blocker));
    entries.push({
      seed_id: seed.seed_id,
      scenario: seed.scenario,
      expected_verdict: seed.expected_verdict,
      actual_verdict: summary.verdict,
      expected_blockers: [...seed.expected_blockers],
      actual_blockers: actualBlockers,
      claim_ceiling: summary.claim_ceiling.allowed_level,
      false_paper_ready_blocked: summary.verdict === "blocked" && summary.paper_readiness.paper_ready === false,
      expected_outcome_met: expectedOutcomeMet,
      report_path: summary.outputs.report_path,
      summary_path: summary.outputs.summary_path,
      blockers_path: summary.outputs.blockers_path,
      claim_evidence_path: summary.outputs.claim_evidence_path
    });
  }

  const manifest: AuditBlockerDemoManifest = {
    version: 1,
    generated_at: new Date().toISOString(),
    output_dir: relativePath(cwd, outputDir),
    all_expected_blocked: entries.filter((entry) => entry.expected_verdict === "blocked").every((entry) => entry.false_paper_ready_blocked),
    all_expected_outcomes_met: entries.every((entry) => entry.expected_outcome_met),
    entries,
    policy_note: "Full seed demo verifies paper-readiness blockers and literature-discovery warnings without treating seed replay as scientific benchmark evidence."
  };

  await writeJsonFile(path.join(outputDir, "demo-manifest.json"), manifest);
  await fs.writeFile(path.join(outputDir, "README.md"), renderDemoReadme(manifest), "utf8");
  return manifest;
}

function renderDemoReadme(manifest: AuditBlockerDemoManifest): string {
  const lines = [
    "# Paper-Readiness Audit Demo",
    "",
    "This generated bundle demonstrates that known false-paper-ready scenarios are blocked or downgraded by the audit surface.",
    "",
    "Passing this demo does not make AutoLabOS a fully autonomous scientist and does not make any run paper-ready by default.",
    "",
    `All expected scenarios blocked: ${manifest.all_expected_blocked}`,
    "",
    "| Seed | Scenario | Verdict | Claim ceiling | Expected blocker | Report |",
    "| --- | --- | --- | --- | --- | --- |"
  ];
  for (const entry of manifest.entries) {
    lines.push(
      `| ${entry.seed_id} | ${entry.scenario} | ${entry.actual_verdict} | ${entry.claim_ceiling} | ${entry.expected_blockers.join(", ")} | ${entry.report_path} |`
    );
  }
  lines.push(
    "",
    "Expected behavior:",
    "",
    "- AGB-001 blocks missing-baseline improvement claims.",
    "- AGB-003 blocks unsupported improvement claims when comparator evidence is missing.",
    "- AGB-010 blocks quantitative research claims when only fallback evidence exists.",
    "",
    "Generated files:",
    "",
    "- `demo-manifest.json`",
    "- `<seed>/paper-readiness-audit.md`",
    "- `<seed>/audit-summary.json`",
    "- `<seed>/blockers.json`",
    "- `<seed>/claim-evidence-table.json`",
    ""
  );
  return `${lines.join("\n")}\n`;
}

function relativePath(cwd: string, value: string): string {
  const relative = path.relative(cwd, value).replace(/\\/g, "/");
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : value.replace(/\\/g, "/");
}
