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
const validationRoot = process.env.AUTOLABOS_VALIDATION_WORKSPACE_ROOT
  ? path.resolve(process.env.AUTOLABOS_VALIDATION_WORKSPACE_ROOT)
  : os.tmpdir();
let reportPath;

const CORE_GATES = [
  {
    id: "direct_research_acceptance",
    script: "scripts/validate-research-governance-e2e.mjs",
    args: [],
    expectedGate: "research_governance_process_e2e",
    repairTarget: "core_research_governance"
  },
  {
    id: "repo_bridge_acceptance",
    script: "scripts/validate-plugin-bridge-e2e.mjs",
    args: [],
    expectedGate: "plugin_bridge_process_e2e",
    repairTarget: "repo_plugin_bridge"
  },
  {
    id: "hermetic_cache_acceptance",
    script: "scripts/validate-plugin-hermetic-cache.mjs",
    args: [],
    expectedGate: "plugin_hermetic_cache_e2e",
    repairTarget: "plugin_cache_lifecycle"
  },
  {
    id: "fault_injection_matrix",
    script: "scripts/validate-plugin-fault-matrix.mjs",
    args: [],
    expectedGate: "plugin_fault_injection_matrix",
    repairTarget: "plugin_failure_handling"
  }
];

const LOCAL_GATES = [
  {
    id: "installed_bridge_acceptance",
    script: "scripts/validate-plugin-bridge-e2e.mjs",
    args: ["--installed"],
    expectedGate: "plugin_bridge_process_e2e",
    repairTarget: "installed_plugin_cache"
  },
  {
    id: "installed_plugin_discovery",
    script: "plugins/autolabos-research-governor/scripts/plugin-discovery-check.mjs",
    args: [],
    expectedGate: "local_codex_plugin_discovery",
    repairTarget: "plugin_installation_discovery",
    reportCapable: false
  }
];

function parseJson(output) {
  const start = output.indexOf("{");
  return start >= 0 ? JSON.parse(output.slice(start)) : null;
}

function runGate(spec, reportRoot) {
  if (process.env.AUTOLABOS_OPERATIONS_FAIL_GATE === spec.id) {
    return {
      id: spec.id,
      passed: false,
      verdict: "injected_failure",
      expectedGate: spec.expectedGate,
      observedGate: "injected_failure",
      repairTarget: spec.repairTarget,
      reportPersisted: false
    };
  }
  const scriptPath = path.join(repoRoot, spec.script);
  if (!fs.existsSync(scriptPath)) {
    return {
      id: spec.id,
      passed: false,
      verdict: "missing_runner",
      expectedGate: spec.expectedGate,
      repairTarget: spec.repairTarget,
      reportPersisted: false
    };
  }

  const childReportPath = path.join(reportRoot, `${spec.id}.json`);
  const childArgs = spec.reportCapable === false
    ? spec.args
    : [...spec.args, "--report", childReportPath];
  const result = spawnSync(process.execPath, [scriptPath, ...childArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env
  });
  const persisted = spec.reportCapable !== false && fs.existsSync(childReportPath)
    ? parseJson(fs.readFileSync(childReportPath, "utf8"))
    : null;
  const emitted = parseJson(result.stdout || "");
  const childReport = persisted || emitted;
  const reportPersisted = spec.reportCapable === false || Boolean(persisted);
  const passed = result.status === 0
    && childReport?.verdict === "pass"
    && childReport?.gate === spec.expectedGate
    && reportPersisted;

  return {
    id: spec.id,
    passed,
    verdict: childReport?.verdict || "missing_report",
    expectedGate: spec.expectedGate,
    observedGate: childReport?.gate || "missing_gate",
    executionSurface: childReport?.executionSurface,
    checkCount: Array.isArray(childReport?.checks)
      ? childReport.checks.length
      : Array.isArray(childReport?.cases) ? childReport.cases.length : undefined,
    repairTarget: spec.repairTarget,
    reportPersisted
  };
}

function main() {
  const args = process.argv.slice(2);
  const localCount = args.filter((arg) => arg === "--local").length;
  if (localCount > 1) throw new Error("--local may be specified only once.");
  const local = localCount === 1;
  const options = parseOptionalReportArg(args.filter((arg) => arg !== "--local"));
  reportPath = options.reportPath;
  const validationCommand = local
    ? "npm run validate:plugin-operations:local"
    : "npm run validate:plugin-operations";
  if (options.help) {
    process.stdout.write([
      "Usage:",
      "  npm run validate:plugin-operations [-- --report <path>]",
      "  npm run validate:plugin-operations:local [-- --report <path>]",
      "",
      "CI mode runs direct, repo bridge, hermetic cache, and fault gates.",
      "Local mode additionally requires installed bridge and Codex discovery gates."
    ].join("\n") + "\n");
    return;
  }
  if (!fs.existsSync(path.join(repoRoot, "dist", "cli", "main.js"))) {
    throw new Error("Built CLI not found. Run npm run build before this validation.");
  }

  fs.mkdirSync(validationRoot, { recursive: true });
  const reportRoot = fs.mkdtempSync(path.join(validationRoot, "autolabos-plugin-operations-"));
  try {
    const specs = local ? [...CORE_GATES, ...LOCAL_GATES] : CORE_GATES;
    const gates = specs.map((spec) => runGate(spec, reportRoot));
    const failed = gates.filter((gate) => !gate.passed);
    const report = writeValidationReport({
      commandIntent: "research:audit",
      outputArtifact: "GateReport",
      verdict: failed.length === 0 ? "pass" : "fail",
      gate: "plugin_operations_preflight",
      mode: local ? "local" : "ci",
      requiredGateCount: gates.length,
      passedGateCount: gates.length - failed.length,
      failedGateCount: failed.length,
      partialSuccessPromoted: false,
      gates,
      recommendations: failed.map((gate) => gate.repairTarget),
      validationCommand
    }, reportPath);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = failed.length === 0 ? 0 : 1;
  } finally {
    fs.rmSync(reportRoot, { recursive: true, force: true });
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
    gate: "plugin_operations_preflight",
    message,
    validationCommand: process.argv.includes("--local")
      ? "npm run validate:plugin-operations:local"
      : "npm run validate:plugin-operations"
  }, reportPath);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = 1;
}
