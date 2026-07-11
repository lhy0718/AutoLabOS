#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runResearchGovernanceAcceptance } from "./lib/research-governance-acceptance.mjs";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const cliPath = path.join(repoRoot, "dist", "cli", "main.js");
const validationCommand = "npm run validate:research-governance";

function main() {
  if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
    process.stdout.write(`Usage: ${validationCommand}\nRequires a current npm run build output.\n`);
    return;
  }
  if (process.argv.length > 2) {
    process.stderr.write(`Unknown validation argument: ${process.argv.slice(2).join(", ")}\n`);
    process.exitCode = 2;
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
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    commandIntent: "research:audit",
    outputArtifact: "GateReport",
    verdict: "fail",
    gate: "research_governance_process_e2e",
    executionSurface: "direct_cli",
    message: error instanceof Error ? error.message : String(error),
    validationCommand
  }, null, 2)}\n`);
  process.exitCode = 1;
}
