import { createHash } from "node:crypto";
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
  copied_file_bindings: Array<{
    path: string;
    sha256: string;
    bytes: number;
  }>;
  copied_file_mappings: Array<{
    source_ref: string;
    copied_path: string;
    sha256: string;
    bytes: number;
  }>;
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
  path.join("paper", "references.bib"),
  path.join("paper", "academic_claim_evidence_map.json"),
  path.join("paper", "reference_evidence_status.json"),
  path.join("paper", "submission_status.json"),
  path.join("paper", "refgate_claims.tsv"),
  path.join("paper", "draft.md"),
  path.join("paper", "main.md"),
  path.join("logs", "run.log"),
  path.join("logs", "stderr.log"),
  path.join("logs", "stdout.log")
];

const ACADEMIC_PACKAGE_ALIASES = [
  { source: "manuscript.tex", destination: path.join("paper", "main.tex") },
  { source: "references.bib", destination: path.join("paper", "references.bib") },
  { source: "claim-evidence-map.json", destination: path.join("paper", "academic_claim_evidence_map.json") },
  { source: "reference-evidence-status.json", destination: path.join("paper", "reference_evidence_status.json") },
  { source: "submission-status.json", destination: path.join("paper", "submission_status.json") },
  { source: "refgate_claims.tsv", destination: path.join("paper", "refgate_claims.tsv") }
] as const;

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
  const copiedFileMappings: Array<{ source_ref: string; copied_path: string }> = [];
  for (const relativeFile of ALLOWLISTED_RELATIVE_FILES) {
    const normalizedRelativeFile = normalizeRelativeFile(relativeFile);
    const sourcePath = path.join(sourceRoot, normalizedRelativeFile);
    if (!(await fileExists(sourcePath))) {
      continue;
    }
    await copyFile(sourcePath, path.join(runRoot, normalizedRelativeFile));
    copiedFiles.push(normalizedRelativeFile);
    copiedFileMappings.push({
      source_ref: normalizedRelativeFile,
      copied_path: normalizedRelativeFile
    });
  }

  for (const alias of ACADEMIC_PACKAGE_ALIASES) {
    const sourcePath = path.join(sourceRoot, alias.source);
    const destinationPath = path.join(runRoot, alias.destination);
    if (!(await fileExists(sourcePath)) || await fileExists(destinationPath)) {
      continue;
    }
    await copyFile(sourcePath, destinationPath);
    const copiedPath = normalizeRelativeFile(alias.destination);
    copiedFiles.push(copiedPath);
    copiedFileMappings.push({ source_ref: alias.source, copied_path: copiedPath });
  }

  if (input.draftPath) {
    await copyFile(path.resolve(cwd, input.draftPath), path.join(runRoot, "paper", "draft.md"));
    copiedFiles.push("paper/draft.md");
    copiedFileMappings.push({ source_ref: "<explicit-draft>", copied_path: "paper/draft.md" });
  }
  if (input.logPath) {
    await copyFile(path.resolve(cwd, input.logPath), path.join(runRoot, "logs", "external.log"));
    copiedFiles.push("logs/external.log");
    copiedFileMappings.push({ source_ref: "<explicit-log>", copied_path: "logs/external.log" });
  }

  const uniqueCopiedFiles = [...new Set(copiedFiles)].sort();
  const copiedFileBindings = await Promise.all(uniqueCopiedFiles.map(async (relativeFile) => {
    const bytes = await fs.readFile(path.join(runRoot, relativeFile));
    return {
      path: relativeFile,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength
    };
  }));
  const bindingsByPath = new Map(copiedFileBindings.map((binding) => [binding.path, binding] as const));
  const normalizedMappings = copiedFileMappings
    .map((mapping) => {
      const binding = bindingsByPath.get(mapping.copied_path);
      return binding ? { ...mapping, sha256: binding.sha256, bytes: binding.bytes } : undefined;
    })
    .filter((mapping): mapping is NonNullable<typeof mapping> => Boolean(mapping))
    .sort((left, right) =>
      left.copied_path.localeCompare(right.copied_path)
      || left.source_ref.localeCompare(right.source_ref)
    );
  const manifest: ExternalArtifactIntakeManifest = {
    version: 1,
    generated_at: new Date().toISOString(),
    source_ref: "<external-artifact-root>",
    run_root: normalizePath(path.relative(cwd, runRoot)),
    copied_files: uniqueCopiedFiles,
    copied_file_bindings: copiedFileBindings,
    copied_file_mappings: normalizedMappings,
    explicit_inputs: {
      draft: Boolean(input.draftPath),
      log: Boolean(input.logPath)
    },
    policy_note: "External intake copies only allowlisted artifacts, records portable source-to-copy mappings, binds every copied file by SHA-256 and byte length, and omits machine-local source paths."
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
