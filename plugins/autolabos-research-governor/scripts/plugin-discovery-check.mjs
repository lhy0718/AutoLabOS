#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const pluginRoot = path.resolve(path.dirname(__filename), "..");
const repoRoot = path.resolve(pluginRoot, "..", "..");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function parsePluginList(output, pluginName, marketplaceName) {
  const target = `${pluginName}@${marketplaceName}`;
  const line = output
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.startsWith(`${target} `));

  if (!line) {
    return { found: false, installed: false, enabled: false, version: null, pluginPath: null };
  }

  const columns = line.split(/\s{2,}/u);
  const status = columns[1] || "";
  return {
    found: columns[0] === target,
    installed: /(?:^|,\s*)installed(?:,|$)/u.test(status),
    enabled: /(?:^|,\s*)enabled(?:,|$)/u.test(status),
    version: columns[2] || null,
    pluginPath: columns[3] || null
  };
}

export function buildDiscoveryChecks({
  commandStatus,
  commandError,
  output,
  pluginName,
  marketplaceName,
  expectedVersion,
  expectedPluginRoot,
  doctorStatus,
  doctorVerdict,
  skillText
}) {
  const entry = parsePluginList(output, pluginName, marketplaceName);
  const marketplaceHeading = new RegExp("Marketplace `" + escapeRegExp(marketplaceName) + "`", "u");
  const observedRoot = entry.pluginPath ? path.resolve(entry.pluginPath) : null;
  return [
    { id: "codex_plugin_list_exits_zero", passed: commandStatus === 0 && !commandError },
    { id: "local_marketplace_is_listed", passed: marketplaceHeading.test(output) },
    { id: "plugin_entry_is_discovered", passed: entry.found },
    { id: "plugin_is_installed", passed: entry.installed },
    { id: "plugin_is_enabled", passed: entry.enabled },
    {
      id: "discovered_version_matches_manifest",
      passed: entry.version === expectedVersion,
      observedVersion: entry.version,
      expectedVersion
    },
    { id: "discovered_source_matches_repo_plugin", passed: observedRoot === expectedPluginRoot },
    { id: "strict_cache_doctor_passes", passed: doctorStatus === 0 && doctorVerdict === "pass" },
    { id: "cached_skill_keeps_short_name", passed: /^name:\s*autolabos$/mu.test(skillText) }
  ];
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseJson(output) {
  const start = output.indexOf("{");
  return start >= 0 ? JSON.parse(output.slice(start)) : null;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write("Usage: npm run plugin:discovery-check\n");
    return;
  }
  if (args.length > 0) {
    process.stderr.write(`Unknown plugin:discovery-check argument: ${args.join(", ")}\n`);
    process.exitCode = 2;
    return;
  }

  const manifest = readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
  const marketplace = readJson(path.join(repoRoot, ".agents", "plugins", "marketplace.json"));
  const marketplaceName = marketplace.name || "autolabos-local";
  const codexBin = process.env.AUTOLABOS_CODEX_BIN || "codex";
  const listResult = spawnSync(codexBin, ["plugin", "list"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env
  });
  const doctorResult = spawnSync(process.execPath, [
    path.join(pluginRoot, "scripts", "plugin-doctor.mjs"),
    "--strict"
  ], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env
  });
  const doctor = doctorResult.stdout.trim() ? parseJson(doctorResult.stdout) : null;
  const skillText = fs.readFileSync(path.join(pluginRoot, "skills", "autolabos", "SKILL.md"), "utf8");
  const checks = buildDiscoveryChecks({
    commandStatus: listResult.status,
    commandError: listResult.error,
    output: listResult.stdout || "",
    pluginName: manifest.name,
    marketplaceName,
    expectedVersion: manifest.version,
    expectedPluginRoot: pluginRoot,
    doctorStatus: doctorResult.status,
    doctorVerdict: doctor?.verdict,
    skillText
  });
  const failed = checks.filter((check) => !check.passed);
  const report = {
    commandIntent: "research:audit",
    outputArtifact: "GateReport",
    discoveryTarget: manifest.name,
    version: manifest.version,
    verdict: failed.length === 0 ? "pass" : "fail",
    gate: "local_codex_plugin_discovery",
    checks,
    recommendations: failed.length === 0
      ? ["Local Codex discovery, enablement, version, source, cache, and skill checks passed."]
      : ["Install or enable the local marketplace plugin, sync its cache, restart Codex, and rerun this check."],
    validationCommand: "npm run plugin:discovery-check"
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
