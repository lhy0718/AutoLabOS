import path from "node:path";
import { promises as fs } from "node:fs";

import { ensureDir, fileExists, writeJsonFile } from "../../utils/fs.js";

export interface ExternalArtifactIntakeInput {
  cwd: string;
  outDir: string;
  externalRoot: string;
  draftPath?: string;
  logPath?: string;
}

export interface ExternalArtifactIntakeManifest {
  version: 1;
  generated_at: string;
  source_ref: string;
  run_root: string;
  copied_files: string[];
  explicit_inputs: {
    draft: boolean;
    log: boolean;
  };
  policy_note: string;
}

const ALLOWLISTED_RELATIVE_FILES = [
  "governance_condition.json",
  "result_table.json",
  "evidence_store.jsonl",
  "run_record.json",
  "events.jsonl",
  "design_contracts.json",
  path.join("audit", "design_contracts.json"),
  path.join("review", "design_contract_findings.json"),
  path.join("review", "decision.json"),
  path.join("review", "paper_critique.json"),
  path.join("figure_audit", "figure_audit_summary.json"),
  path.join("paper", "claim_evidence_table.json"),
  path.join("paper", "claim_status_table.json"),
  path.join("paper", "evidence_links.json"),
  path.join("paper", "evidence_gate_decision.json"),
  path.join("paper", "paper_readiness.json"),
  path.join("paper", "main.tex"),
  path.join("paper", "draft.md"),
  path.join("paper", "main.md"),
  path.join("logs", "run.log"),
  path.join("logs", "stderr.log"),
  path.join("logs", "stdout.log")
];

export async function materializeExternalAuditArtifacts(
  input: ExternalArtifactIntakeInput
): Promise<{ runRoot: string; manifest: ExternalArtifactIntakeManifest }> {
  const cwd = path.resolve(input.cwd);
  const outputDir = path.resolve(input.outDir);
  const sourceRoot = path.resolve(cwd, input.externalRoot);
  const runRoot = path.join(outputDir, "_external-intake", "run-artifacts");
  await fs.rm(runRoot, { recursive: true, force: true });
  await ensureDir(runRoot);

  const copiedFiles: string[] = [];
  for (const relativeFile of ALLOWLISTED_RELATIVE_FILES) {
    const normalizedRelativeFile = normalizeRelativeFile(relativeFile);
    const sourcePath = path.join(sourceRoot, normalizedRelativeFile);
    if (!(await fileExists(sourcePath))) {
      continue;
    }
    await copyFile(sourcePath, path.join(runRoot, normalizedRelativeFile));
    copiedFiles.push(normalizedRelativeFile);
  }

  if (input.draftPath) {
    await copyFile(path.resolve(cwd, input.draftPath), path.join(runRoot, "paper", "draft.md"));
    copiedFiles.push("paper/draft.md");
  }
  if (input.logPath) {
    await copyFile(path.resolve(cwd, input.logPath), path.join(runRoot, "logs", "external.log"));
    copiedFiles.push("logs/external.log");
  }

  const manifest: ExternalArtifactIntakeManifest = {
    version: 1,
    generated_at: new Date().toISOString(),
    source_ref: "<external-artifact-root>",
    run_root: normalizePath(path.relative(cwd, runRoot)),
    copied_files: [...new Set(copiedFiles)].sort(),
    explicit_inputs: {
      draft: Boolean(input.draftPath),
      log: Boolean(input.logPath)
    },
    policy_note: "External intake copies only allowlisted artifacts into the audit output directory and omits machine-local source paths."
  };
  await writeJsonFile(path.join(outputDir, "external-intake-manifest.json"), manifest);
  return { runRoot, manifest };
}

function normalizeRelativeFile(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/u, "");
}

async function copyFile(sourcePath: string, destinationPath: string): Promise<void> {
  const stat = await fs.stat(sourcePath);
  if (!stat.isFile()) {
    return;
  }
  await ensureDir(path.dirname(destinationPath));
  await fs.copyFile(sourcePath, destinationPath);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}
