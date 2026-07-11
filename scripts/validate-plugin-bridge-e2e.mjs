#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runResearchGovernanceAcceptance } from "./lib/research-governance-acceptance.mjs";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const bridgePath = path.join(
  repoRoot,
  "plugins",
  "autolabos-research-governor",
  "scripts",
  "run-research-intent.mjs"
);
const cliProxyPath = path.join(repoRoot, "scripts", "fixtures", "autolabos-cli-proxy.mjs");
const validationCommand = "npm run validate:plugin-bridge";

function parseJson(output) {
  const start = output.indexOf("{");
  return start >= 0 ? JSON.parse(output.slice(start)) : null;
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg === "--help" || arg === "-h")) {
    process.stdout.write(`Usage: ${validationCommand}\nRequires a current npm run build output.\n`);
    return;
  }
  if (args.length > 0) {
    process.stderr.write(`Unknown plugin bridge validation argument: ${args.join(", ")}\n`);
    process.exitCode = 2;
    return;
  }
  for (const requiredPath of [bridgePath, cliProxyPath, path.join(repoRoot, "dist", "cli", "main.js")]) {
    if (!fs.existsSync(requiredPath)) throw new Error("Plugin bridge acceptance dependency is missing. Run npm run build first.");
  }

  const bridgeEnv = { ...process.env, AUTOLABOS_BIN: cliProxyPath };
  const dependencyResult = spawnSync(process.execPath, [bridgePath, "--check"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: bridgeEnv
  });
  const dependencyReport = dependencyResult.stdout.trim() ? parseJson(dependencyResult.stdout) : null;
  const preflightChecks = [
    {
      id: "bridge_dependency_check_passes",
      passed: dependencyResult.status === 0 && dependencyReport?.verdict === "pass"
    },
    {
      id: "bridge_dependency_report_is_versioned",
      passed: dependencyReport?.schema_version === "1.0"
        && dependencyReport?.artifact_type === "GateReport"
        && dependencyReport?.checks?.done_condition === "pass"
    }
  ];
  if (preflightChecks.some((item) => !item.passed)) {
    throw new Error("Plugin bridge dependency preflight failed.");
  }

  const report = runResearchGovernanceAcceptance({
    repoRoot,
    gate: "plugin_bridge_process_e2e",
    executionSurface: "repo_plugin_bridge_fixture_cli",
    validationCommand,
    workspacePrefix: "autolabos-plugin-bridge-e2e-",
    preflightChecks,
    execute(workspace, researchArgs) {
      return spawnSync(process.execPath, [bridgePath, ...researchArgs], {
        cwd: workspace,
        encoding: "utf8",
        env: bridgeEnv
      });
    }
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  const message = (error instanceof Error ? error.message : String(error)).replaceAll(repoRoot, "<repo-root>");
  process.stdout.write(`${JSON.stringify({
    commandIntent: "research:audit",
    outputArtifact: "GateReport",
    verdict: "fail",
    gate: "plugin_bridge_process_e2e",
    executionSurface: "repo_plugin_bridge_fixture_cli",
    message,
    validationCommand
  }, null, 2)}\n`);
  process.exitCode = 1;
}
