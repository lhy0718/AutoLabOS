#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runResearchGovernanceAcceptance } from "./lib/research-governance-acceptance.mjs";
import { parseOptionalReportArg, writeValidationReport } from "./lib/validation-report.mjs";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const pluginRoot = path.join(repoRoot, "plugins", "autolabos-research-governor");
const repoBridgePath = path.join(pluginRoot, "scripts", "run-research-intent.mjs");
const cliProxyPath = path.join(repoRoot, "scripts", "fixtures", "autolabos-cli-proxy.mjs");
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const marketplacePath = path.join(repoRoot, ".agents", "plugins", "marketplace.json");
let reportPath;

function emitReport(report) {
  const persisted = writeValidationReport(report, reportPath);
  process.stdout.write(`${JSON.stringify(persisted, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseJson(output) {
  const start = output.indexOf("{");
  return start >= 0 ? JSON.parse(output.slice(start)) : null;
}

function digest(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function runJsonScript(scriptPath, args = [], env = process.env) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env
  });
  return { result, report: result.stdout.trim() ? parseJson(result.stdout) : null };
}

function resolveExecutionMode(installed) {
  if (!installed) {
    return {
      bridgePath: repoBridgePath,
      bridgeEnv: { ...process.env, AUTOLABOS_BIN: cliProxyPath },
      executionSurface: "repo_plugin_bridge_fixture_cli",
      validationCommand: "npm run validate:plugin-bridge",
      workspacePrefix: "autolabos-plugin-bridge-e2e-",
      pluginVersion: readJson(manifestPath).version,
      preflightChecks: []
    };
  }

  const manifest = readJson(manifestPath);
  const marketplace = readJson(marketplacePath);
  const marketplaceName = marketplace.name || "autolabos-local";
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
  const installedRoot = path.join(
    codexHome,
    "plugins",
    "cache",
    marketplaceName,
    manifest.name,
    manifest.version
  );
  const installedBridgePath = path.join(installedRoot, "scripts", "run-research-intent.mjs");
  const discovery = runJsonScript(path.join(pluginRoot, "scripts", "plugin-discovery-check.mjs"));
  const installedBridgeExists = fs.existsSync(installedBridgePath);
  const bridgeMatches = installedBridgeExists && digest(installedBridgePath) === digest(repoBridgePath);

  return {
    bridgePath: installedBridgePath,
    bridgeEnv: { ...process.env },
    executionSurface: "installed_plugin_cache_bridge",
    validationCommand: "npm run validate:plugin-bridge:local",
    workspacePrefix: "autolabos-installed-plugin-bridge-e2e-",
    pluginVersion: manifest.version,
    codexHome,
    preflightChecks: [
      {
        id: "installed_plugin_discovery_passes",
        passed: discovery.result.status === 0 && discovery.report?.verdict === "pass"
      },
      { id: "installed_bridge_exists", passed: installedBridgeExists },
      { id: "installed_bridge_matches_repo", passed: bridgeMatches }
    ]
  };
}

function main() {
  const args = process.argv.slice(2);
  const installedCount = args.filter((arg) => arg === "--installed").length;
  if (installedCount > 1) throw new Error("--installed may be specified only once.");
  const installed = installedCount === 1;
  const options = parseOptionalReportArg(args.filter((arg) => arg !== "--installed"));
  reportPath = options.reportPath;
  if (options.help) {
    process.stdout.write([
      "Usage:",
      "  npm run validate:plugin-bridge [-- --report <path>]",
      "  npm run validate:plugin-bridge:local [-- --report <path>]",
      "",
      "The default mode is deterministic and CI-safe; --installed validates the installed Codex plugin cache.",
      "Both modes require a current npm run build output."
    ].join("\n") + "\n");
    return;
  }
  const mode = resolveExecutionMode(installed);
  for (const requiredPath of [mode.bridgePath, path.join(repoRoot, "dist", "cli", "main.js")]) {
    if (!fs.existsSync(requiredPath)) throw new Error("Plugin bridge acceptance dependency is missing. Run npm run build and refresh the plugin installation.");
  }
  if (!installed && !fs.existsSync(cliProxyPath)) {
    throw new Error("Plugin bridge fixture proxy is missing.");
  }
  if (mode.preflightChecks.some((item) => !item.passed)) {
    throw new Error("Installed plugin discovery or cache alignment preflight failed.");
  }

  const dependency = runJsonScript(mode.bridgePath, ["--check"], mode.bridgeEnv);
  const preflightChecks = [
    ...mode.preflightChecks,
    {
      id: "bridge_dependency_check_passes",
      passed: dependency.result.status === 0 && dependency.report?.verdict === "pass"
    },
    {
      id: "bridge_dependency_report_is_versioned",
      passed: dependency.report?.schema_version === "1.0"
        && dependency.report?.artifact_type === "GateReport"
        && dependency.report?.checks?.done_condition === "pass"
    }
  ];
  if (preflightChecks.some((item) => !item.passed)) {
    throw new Error("Plugin bridge dependency preflight failed.");
  }

  const report = runResearchGovernanceAcceptance({
    repoRoot,
    gate: "plugin_bridge_process_e2e",
    executionSurface: mode.executionSurface,
    validationCommand: mode.validationCommand,
    workspacePrefix: mode.workspacePrefix,
    preflightChecks,
    execute(workspace, researchArgs) {
      return spawnSync(process.execPath, [mode.bridgePath, ...researchArgs], {
        cwd: workspace,
        encoding: "utf8",
        env: mode.bridgeEnv
      });
    }
  });
  report.pluginVersion = mode.pluginVersion;
  emitReport(report);
}

try {
  main();
} catch (error) {
  const manifest = fs.existsSync(manifestPath) ? readJson(manifestPath) : null;
  const codexHome = process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), ".codex");
  const message = (error instanceof Error ? error.message : String(error))
    .replaceAll(repoRoot, "<repo-root>")
    .replaceAll(codexHome, "<codex-home>");
  emitReport({
    commandIntent: "research:audit",
    outputArtifact: "GateReport",
    verdict: "fail",
    gate: "plugin_bridge_process_e2e",
    executionSurface: process.argv.includes("--installed") ? "installed_plugin_cache_bridge" : "repo_plugin_bridge_fixture_cli",
    ...(manifest?.version ? { pluginVersion: manifest.version } : {}),
    message,
    validationCommand: process.argv.includes("--installed")
      ? "npm run validate:plugin-bridge:local"
      : "npm run validate:plugin-bridge"
  });
  process.exitCode = 1;
}
