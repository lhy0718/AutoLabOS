#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const allowedIntents = new Set(["new", "audit", "review", "improve", "pack", "verify-pack", "verify-milestone"]);

if (args.includes("--help") || args.includes("-h") || args.length === 0) {
  process.stdout.write([
    "Usage: run-research-intent.mjs <new|audit|review|improve|pack|verify-pack|verify-milestone> [autolabos research options]",
    "       run-research-intent.mjs --check"
  ].join("\n") + "\n");
  process.exit(0);
}

const executable = process.env.AUTOLABOS_BIN?.trim() || "autolabos";

if (args[0] === "--check") {
  const versionResult = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    env: process.env
  });
  const available = !versionResult.error && versionResult.status === 0;
  const helpResult = available
    ? spawnSync(executable, ["research", "--help"], { encoding: "utf8", env: process.env })
    : undefined;
  const helpText = helpResult?.stdout || "";
  const contractCompatible = Boolean(
    available
    && helpResult?.status === 0
    && ["new", "audit", "review", "improve", "pack", "verify-pack", "verify-milestone"].every((intent) => helpText.includes(intent))
  );
  const report = dependencyReport({
    available,
    contractCompatible,
    observedVersion: available ? versionResult.stdout.trim() : undefined
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = available && contractCompatible ? 0 : 1;
} else {
  const intent = args[0];
  if (!allowedIntents.has(intent)) {
    process.stderr.write(`Unsupported research intent: ${intent}\n`);
    process.exit(2);
  }
  const result = spawnSync(executable, ["research", intent, ...args.slice(1)], {
    stdio: "inherit",
    env: process.env
  });
  if (result.error) {
    const report = dependencyReport({ available: false });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
  } else if (result.signal) {
    process.stderr.write(`AutoLabOS research intent terminated by signal ${result.signal}.\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}

function dependencyReport(input) {
  const generatedAt = new Date().toISOString();
  const available = input.available === true;
  const contractCompatible = input.contractCompatible !== false && available;
  const finding = !available
    ? {
        code: "autolabos_cli_dependency_missing",
        severity: "blocker",
        message: "The AutoLabOS CLI is not available to the installed Codex plugin.",
        evidence_refs: []
      }
    : !contractCompatible
      ? {
          code: "autolabos_cli_contract_mismatch",
          severity: "blocker",
          message: "The installed AutoLabOS CLI does not expose the required artifact-first research intents.",
          evidence_refs: []
        }
      : undefined;
  const dependencySeed = JSON.stringify({
    available,
    contractCompatible,
    observedVersion: input.observedVersion || null
  });
  return {
    schema_version: "1.0",
    artifact_type: "PluginDependencyReport",
    artifact_id: `plugin_dependency_report_${createHash("sha256").update(dependencySeed).digest("hex").slice(0, 16)}`,
    generated_at: generatedAt,
    check_intent: "plugin:dependency",
    provenance: {
      source_mode: "governance_artifact",
      source_label: "Codex plugin runtime",
      artifact_refs: []
    },
    verdict: available && contractCompatible ? "pass" : "blocked",
    checks: {
      cli_available: available,
      research_intents_compatible: contractCompatible
    },
    findings: finding ? [finding] : [],
    next_actions: available && contractCompatible
      ? ["Run an artifact-first research intent through the installed AutoLabOS CLI."]
      : [available
          ? "Install a compatible AutoLabOS CLI that exposes all artifact-first research intents."
          : "Install or expose the AutoLabOS CLI, then rerun the plugin dependency check."],
    ...(input.observedVersion ? { observed_version: input.observedVersion } : {})
  };
}
