#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseOptionalReportArg, writeValidationReport } from "./lib/validation-report.mjs";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const pluginRoot = path.join(repoRoot, "plugins", "autolabos-research-governor");
const bridgePath = path.join(pluginRoot, "scripts", "run-research-intent.mjs");
const doctorPath = path.join(pluginRoot, "scripts", "plugin-doctor.mjs");
const syncPath = path.join(pluginRoot, "scripts", "sync-cache.mjs");
const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
const marketplacePath = path.join(repoRoot, ".agents", "plugins", "marketplace.json");
const cliPath = path.join(repoRoot, "dist", "cli", "main.js");
const validationCommand = "npm run validate:plugin-faults";
let reportPath;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseJson(output) {
  const start = output.indexOf("{");
  return start >= 0 ? JSON.parse(output.slice(start)) : null;
}

function runNode(scriptPath, args = [], options = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd || repoRoot,
    encoding: "utf8",
    env: options.env || process.env
  });
}

function runCli(workspace, args) {
  return runNode(cliPath, ["research", ...args], { cwd: workspace });
}

function successfulJson(result, label) {
  if (result.status !== 0) throw new Error(`${label} did not complete successfully.`);
  const payload = parseJson(result.stdout);
  if (!payload) throw new Error(`${label} did not emit JSON.`);
  return payload;
}

function caseResult(id, passed, expectedBehavior, observedVerdict, repairTarget) {
  return { id, passed: Boolean(passed), expectedBehavior, observedVerdict, repairTarget };
}

function createFakeCli(filePath) {
  const source = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("autolabos 9.9.9\\n");
} else if (args[0] === "research" && args[1] === "--help") {
  const compatible = process.env.FAULT_CLI_COMPATIBLE === "1";
  process.stdout.write(compatible ? "new audit review improve pack\\n" : "new audit review improve\\n");
} else {
  process.exitCode = 2;
}
`;
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function privatePathFixture() {
  return String.fromCharCode(47, 104, 111, 109, 101, 47) + "example/private-artifact.json";
}

function main() {
  const options = parseOptionalReportArg(process.argv.slice(2));
  reportPath = options.reportPath;
  if (options.help) {
    process.stdout.write(`Usage: ${validationCommand} [-- --report <path>]\nRequires a current npm run build output.\n`);
    return;
  }
  for (const requiredPath of [bridgePath, doctorPath, syncPath, manifestPath, marketplacePath, cliPath]) {
    if (!fs.existsSync(requiredPath)) throw new Error("Fault matrix dependency is missing. Run npm run build first.");
  }

  const validationRoot = process.env.AUTOLABOS_VALIDATION_WORKSPACE_ROOT
    ? path.resolve(process.env.AUTOLABOS_VALIDATION_WORKSPACE_ROOT)
    : os.tmpdir();
  fs.mkdirSync(validationRoot, { recursive: true });
  const workspace = fs.mkdtempSync(path.join(validationRoot, "autolabos-plugin-fault-matrix-"));
  const cases = [];

  try {
    const missingCli = runNode(bridgePath, ["--check"], {
      env: { ...process.env, AUTOLABOS_BIN: "autolabos-cli-not-present" }
    });
    const missingCliReport = parseJson(missingCli.stdout);
    cases.push(caseResult(
      "missing_cli",
      missingCli.status === 1
        && missingCliReport?.verdict === "blocked"
        && missingCliReport?.findings?.some((finding) => finding.code === "autolabos_cli_dependency_missing"),
      "blocking dependency GateReport",
      missingCliReport?.verdict || "missing_report",
      "install_or_expose_cli"
    ));

    const fakeCli = path.join(workspace, "autolabos-fixture");
    createFakeCli(fakeCli);
    const mismatch = runNode(bridgePath, ["--check"], {
      env: { ...process.env, AUTOLABOS_BIN: fakeCli }
    });
    const mismatchReport = parseJson(mismatch.stdout);
    const compatible = runNode(bridgePath, ["--check"], {
      env: { ...process.env, AUTOLABOS_BIN: fakeCli, FAULT_CLI_COMPATIBLE: "1" }
    });
    const compatibleReport = parseJson(compatible.stdout);
    cases.push(caseResult(
      "cli_contract_mismatch",
      mismatch.status === 1
        && mismatchReport?.verdict === "blocked"
        && mismatchReport?.findings?.some((finding) => finding.code === "autolabos_cli_contract_mismatch")
        && compatible.status === 0
        && compatibleReport?.verdict === "pass"
        && mismatchReport?.artifact_id !== compatibleReport?.artifact_id,
      "distinct blocking contract-mismatch GateReport",
      mismatchReport?.verdict || "missing_report",
      "install_compatible_cli"
    ));

    const manifest = readJson(manifestPath);
    const marketplace = readJson(marketplacePath);
    const marketplaceName = marketplace.name || "autolabos-local";
    const missingHome = path.join(workspace, "missing-cache-home");
    fs.mkdirSync(missingHome, { recursive: true });
    const missingCache = runNode(doctorPath, ["--strict"], {
      env: { ...process.env, CODEX_HOME: missingHome }
    });
    const missingCacheReport = parseJson(missingCache.stdout);
    cases.push(caseResult(
      "missing_cache",
      missingCache.status === 1 && missingCacheReport?.verdict === "not_installed",
      "strict doctor rejection",
      missingCacheReport?.verdict || "missing_report",
      "sync_or_reinstall_plugin_cache"
    ));

    const staleHome = path.join(workspace, "stale-cache-home");
    fs.mkdirSync(path.join(
      staleHome,
      "plugins",
      "cache",
      marketplaceName,
      manifest.name,
      "0.0.0+codex.stale"
    ), { recursive: true });
    const staleCache = runNode(doctorPath, ["--strict"], {
      env: { ...process.env, CODEX_HOME: staleHome }
    });
    const staleCacheReport = parseJson(staleCache.stdout);
    cases.push(caseResult(
      "stale_cache_version",
      staleCache.status === 1
        && staleCacheReport?.verdict === "cache_update_required"
        && staleCacheReport?.installedCache?.exactVersionFound === false,
      "strict version mismatch rejection",
      staleCacheReport?.verdict || "missing_report",
      "refresh_plugin_cache_version"
    ));

    const driftHome = path.join(workspace, "drift-cache-home");
    const sync = runNode(syncPath, ["--write"], {
      env: { ...process.env, CODEX_HOME: driftHome }
    });
    if (sync.status !== 0) throw new Error("Unable to prepare drift fault cache.");
    const cachedBridge = path.join(
      driftHome,
      "plugins",
      "cache",
      marketplaceName,
      manifest.name,
      manifest.version,
      "scripts",
      "run-research-intent.mjs"
    );
    fs.appendFileSync(cachedBridge, "\n// deterministic drift fixture\n", "utf8");
    const drift = runNode(doctorPath, ["--strict"], {
      env: { ...process.env, CODEX_HOME: driftHome }
    });
    const driftReport = parseJson(drift.stdout);
    const bridgeComparison = driftReport?.installedCache?.comparisons?.find(
      (item) => item.relativePath === "scripts/run-research-intent.mjs"
    );
    cases.push(caseResult(
      "bridge_drift",
      drift.status === 1
        && driftReport?.verdict === "cache_update_required"
        && bridgeComparison?.status === "drift",
      "strict bridge hash rejection",
      driftReport?.verdict || "missing_report",
      "reinstall_drifted_plugin"
    ));

    const weakRoot = path.join(workspace, "weak-input");
    fs.mkdirSync(weakRoot, { recursive: true });
    const gateResult = successfulJson(runCli(workspace, [
      "audit", "--external", "weak-input", "--out-dir", "outputs/audit"
    ]), "fault setup audit");
    const reviewResult = successfulJson(runCli(workspace, [
      "review", "--gate", gateResult.output_path, "--out-dir", "outputs/review"
    ]), "fault setup review");
    const invalidGatePath = path.join(workspace, "invalid-gate.json");
    fs.writeFileSync(invalidGatePath, `${JSON.stringify({ ...gateResult.artifact, schema_version: "2.0" }, null, 2)}\n`, "utf8");
    const schemaMismatch = runCli(workspace, [
      "review", "--gate", "invalid-gate.json", "--out-dir", "outputs/invalid-review"
    ]);
    cases.push(caseResult(
      "schema_mismatch",
      schemaMismatch.status === 1
        && schemaMismatch.stderr.includes("Expected schema version 1.0")
        && !schemaMismatch.stderr.includes("\n    at ")
        && !schemaMismatch.stderr.includes(workspace),
      "concise schema-version rejection",
      schemaMismatch.status === 1 ? "blocked" : "unexpected_success",
      "regenerate_compatible_artifact"
    ));

    fs.writeFileSync(
      path.join(workspace, "outputs", "audit", "audit-summary.json"),
      `${JSON.stringify({ source: privatePathFixture() }, null, 2)}\n`,
      "utf8"
    );
    const nonPortable = successfulJson(runCli(workspace, [
      "pack",
      "--gate", gateResult.output_path,
      "--review", reviewResult.output_path,
      "--source-dir", "outputs/audit",
      "--out-dir", "outputs/pack"
    ]), "non-portable pack fault");
    cases.push(caseResult(
      "non_portable_bundle_content",
      nonPortable.artifact?.portability?.valid === false
        && nonPortable.artifact?.portability?.issues?.some((issue) => issue.includes("audit-summary.json"))
        && nonPortable.artifact?.files?.every((file) => file.path !== "artifacts/audit-summary.json"),
      "exclude unsafe file and downgrade portability",
      nonPortable.artifact?.portability?.valid === false ? "excluded" : "unexpected_portable",
      "remove_private_or_sensitive_content"
    ));

    const failedCases = cases.filter((item) => !item.passed);
    const report = writeValidationReport({
      commandIntent: "research:audit",
      outputArtifact: "GateReport",
      verdict: failedCases.length === 0 ? "pass" : "fail",
      gate: "plugin_fault_injection_matrix",
      caseCount: cases.length,
      cases,
      recommendations: failedCases.map((item) => item.repairTarget),
      validationCommand
    }, reportPath);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = failedCases.length === 0 ? 0 : 1;
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
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
    gate: "plugin_fault_injection_matrix",
    message,
    validationCommand
  }, reportPath);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = 1;
}
