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
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const marketplacePath = path.join(repoRoot, ".agents", "plugins", "marketplace.json");
const syncPath = path.join(pluginRoot, "scripts", "sync-cache.mjs");
const doctorPath = path.join(pluginRoot, "scripts", "plugin-doctor.mjs");
const repoBridgePath = path.join(pluginRoot, "scripts", "run-research-intent.mjs");
const cliProxyPath = path.join(repoRoot, "scripts", "fixtures", "autolabos-cli-proxy.mjs");
const cliPath = path.join(repoRoot, "dist", "cli", "main.js");
const validationCommand = "npm run validate:plugin-hermetic";
let reportPath;

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

function runNode(scriptPath, args, env, cwd = repoRoot) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    env
  });
}

function main() {
  const options = parseOptionalReportArg(process.argv.slice(2));
  reportPath = options.reportPath;
  if (options.help) {
    process.stdout.write(`Usage: ${validationCommand} [-- --report <path>]\nRequires a current npm run build output.\n`);
    return;
  }
  for (const requiredPath of [
    manifestPath,
    marketplacePath,
    syncPath,
    doctorPath,
    repoBridgePath,
    cliProxyPath,
    cliPath
  ]) {
    if (!fs.existsSync(requiredPath)) throw new Error("Hermetic plugin acceptance dependency is missing.");
  }

  const validationRoot = process.env.AUTOLABOS_VALIDATION_WORKSPACE_ROOT
    ? path.resolve(process.env.AUTOLABOS_VALIDATION_WORKSPACE_ROOT)
    : os.tmpdir();
  fs.mkdirSync(validationRoot, { recursive: true });
  const sandboxRoot = fs.mkdtempSync(path.join(validationRoot, "autolabos-plugin-hermetic-"));
  const codexHome = path.join(sandboxRoot, "codex-home");
  const manifest = readJson(manifestPath);
  const marketplace = readJson(marketplacePath);
  const marketplaceName = marketplace.name || "autolabos-local";
  const baseEnv = { ...process.env, CODEX_HOME: codexHome };

  try {
    const syncResult = runNode(syncPath, ["--write"], baseEnv);
    const syncReport = parseJson(syncResult.stdout);
    const cacheRoot = path.join(
      codexHome,
      "plugins",
      "cache",
      marketplaceName,
      manifest.name,
      manifest.version
    );
    const cachedBridgePath = path.join(cacheRoot, "scripts", "run-research-intent.mjs");
    const doctorResult = runNode(doctorPath, ["--strict"], baseEnv);
    const doctorReport = parseJson(doctorResult.stdout);
    const bridgeExists = fs.existsSync(cachedBridgePath);
    const bridgeMatches = bridgeExists && digest(cachedBridgePath) === digest(repoBridgePath);
    const bridgeEnv = { ...baseEnv, AUTOLABOS_BIN: cliProxyPath };
    const dependencyResult = bridgeExists
      ? runNode(cachedBridgePath, ["--check"], bridgeEnv)
      : { status: 1, stdout: "" };
    const dependencyReport = parseJson(dependencyResult.stdout || "");
    const preflightChecks = [
      {
        id: "hermetic_cache_sync_passes",
        passed: syncResult.status === 0
          && syncReport?.verdict === "synced"
          && syncReport?.version === manifest.version
      },
      {
        id: "hermetic_strict_doctor_passes",
        passed: doctorResult.status === 0
          && doctorReport?.verdict === "pass"
          && doctorReport?.installedCache?.exactVersionFound === true
      },
      { id: "hermetic_cached_bridge_exists", passed: bridgeExists },
      { id: "hermetic_cached_bridge_matches_repo", passed: bridgeMatches },
      {
        id: "hermetic_bridge_dependency_passes",
        passed: dependencyResult.status === 0
          && dependencyReport?.verdict === "pass"
          && dependencyReport?.schema_version === "1.0"
      }
    ];
    if (preflightChecks.some((item) => !item.passed)) {
      throw new Error("Hermetic cache preflight failed.");
    }

    const report = runResearchGovernanceAcceptance({
      repoRoot,
      gate: "plugin_hermetic_cache_e2e",
      executionSurface: "hermetic_cache_bridge_fixture_cli",
      validationCommand,
      workspacePrefix: "autolabos-hermetic-cache-chain-",
      preflightChecks,
      execute(workspace, researchArgs) {
        return runNode(cachedBridgePath, researchArgs, bridgeEnv, workspace);
      }
    });
    report.pluginVersion = manifest.version;
    report.cacheSource = "temporary_isolated_codex_home";
    const persisted = writeValidationReport(report, reportPath);
    process.stdout.write(`${JSON.stringify(persisted, null, 2)}\n`);
  } finally {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  const message = (error instanceof Error ? error.message : String(error)).replaceAll(repoRoot, "<repo-root>");
  const report = writeValidationReport({
    commandIntent: "research:audit",
    outputArtifact: "GateReport",
    verdict: "fail",
    gate: "plugin_hermetic_cache_e2e",
    executionSurface: "hermetic_cache_bridge_fixture_cli",
    message,
    validationCommand
  }, reportPath);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = 1;
}
