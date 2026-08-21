#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runResearchGovernanceAcceptance } from "./lib/research-governance-acceptance.mjs";
import { parseOptionalReportArg, writeValidationReport } from "./lib/validation-report.mjs";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const cliPath = path.join(repoRoot, "dist", "cli", "main.js");
const validationCommand = "npm run validate:research-governance";
let reportPath;

function emitReport(report) {
  const persisted = writeValidationReport(report, reportPath);
  process.stdout.write(`${JSON.stringify(persisted, null, 2)}\n`);
}

function main() {
  const options = parseOptionalReportArg(process.argv.slice(2));
  reportPath = options.reportPath;
  if (options.help) {
    process.stdout.write(`Usage: ${validationCommand} [-- --report <path>]\nRequires a current npm run build output.\n`);
    return;
  }
  if (!fs.existsSync(cliPath)) {
    throw new Error("Built CLI not found. Run npm run build before this validation.");
  }

  const report = runResearchGovernanceAcceptance({
    repoRoot,
    gate: "research_governance_process_e2e",
    executionSurface: "direct_cli",
    validationCommand,
    execute(workspace, args) {
      return spawnSync(process.execPath, [cliPath, "research", ...args], {
        cwd: workspace,
        encoding: "utf8",
        env: process.env
      });
    }
  });
  emitReport(report);
}

try {
  main();
} catch (error) {
  emitReport({
    commandIntent: "research:audit",
    outputArtifact: "GateReport",
    verdict: "fail",
    gate: "research_governance_process_e2e",
    executionSurface: "direct_cli",
    message: (error instanceof Error ? error.message : String(error)).replaceAll(repoRoot, "<repo-root>"),
    validationCommand
  });
  process.exitCode = 1;
}
