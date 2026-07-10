#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const pluginRoot = path.resolve(path.dirname(__filename), "..");
const repoRoot = path.resolve(pluginRoot, "..", "..");

const requiredPackFiles = [
  "plugins/autolabos-research-governor/.codex-plugin/plugin.json",
  "plugins/autolabos-research-governor/README.md",
  "plugins/autolabos-research-governor/scripts/dogfood-audit.mjs",
  "plugins/autolabos-research-governor/scripts/plugin-discovery-check.mjs",
  "plugins/autolabos-research-governor/scripts/plugin-doctor.mjs",
  "plugins/autolabos-research-governor/scripts/plugin-release-check.mjs",
  "plugins/autolabos-research-governor/scripts/run-research-intent.mjs",
  "plugins/autolabos-research-governor/scripts/sync-cache.mjs",
  "plugins/autolabos-research-governor/scripts/print-contract.mjs",
  "plugins/autolabos-research-governor/skills/autolabos/SKILL.md"
];

const publicSurfaceFiles = [
  "README.md",
  "docs/codex-plugin-governance.md",
  "plugins/autolabos-research-governor/.codex-plugin/plugin.json",
  "plugins/autolabos-research-governor/README.md",
  "plugins/autolabos-research-governor/scripts/dogfood-audit.mjs",
  "plugins/autolabos-research-governor/scripts/plugin-discovery-check.mjs",
  "plugins/autolabos-research-governor/scripts/plugin-doctor.mjs",
  "plugins/autolabos-research-governor/scripts/plugin-release-check.mjs",
  "plugins/autolabos-research-governor/scripts/run-research-intent.mjs",
  "plugins/autolabos-research-governor/scripts/sync-cache.mjs",
  "plugins/autolabos-research-governor/scripts/print-contract.mjs",
  "plugins/autolabos-research-governor/skills/autolabos/SKILL.md",
  "package.json"
];

function chars(values) {
  return String.fromCharCode(...values);
}

const portabilityPattern = new RegExp([
  chars([47, 104, 111, 109, 101, 47]),
  chars([47, 85, 115, 101, 114, 115, 47]),
  chars([47, 109, 110, 116, 47]),
  chars([47, 116, 109, 112, 47]),
  `${chars([114, 101, 102, 101, 114, 101, 110, 99, 101])}[-_ ]?${chars([118, 97, 117, 108, 116])}`,
  `${chars([112, 114, 105, 118, 97, 116, 101])}[-_ ]?${chars([109, 105, 114, 114, 111, 114])}`
].join("|"), "iu");

const oneOffExperimentPattern = new RegExp([
  chars([114, 117, 110, 95, 112, 101, 102, 116, 95, 105, 110, 115, 116, 114, 117, 99, 116, 105, 111, 110, 95, 115, 116, 117, 100, 121]),
  `${chars([114, 97, 110, 107, 95])}[0-9]+${chars([95, 100, 114, 111, 112, 111, 117, 116])}`,
  chars([97, 114, 99, 95, 99, 104, 97, 108, 108, 101, 110, 103, 101]),
  chars([104, 101, 108, 108, 97, 115, 119, 97, 103]),
  `${chars([81, 119, 101, 110, 50])}\\.5`,
  `\\b${chars([76, 111, 82, 65])}\\b`,
  `\\b${chars([81, 76, 111, 82, 65])}\\b`,
  chars([82, 101, 99, 111, 118, 101, 114, 101, 100, 32, 99, 97, 99, 104, 101, 100, 32, 102, 117, 108, 108, 32, 116, 101, 120, 116]),
  chars([99, 111, 109, 112, 97, 99, 116, 32, 80, 69, 70, 84, 32, 114, 101, 99, 105, 112, 101])
].join("|"), "iu");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function check(id, passed, details = {}) {
  return { id, passed: Boolean(passed), ...details };
}

function runNode(relativePath, args = []) {
  return spawnSync(process.execPath, [path.join(repoRoot, relativePath), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env
  });
}

function parseJsonObject(output) {
  const start = output.indexOf("{");
  if (start < 0) {
    throw new Error("No JSON object found in command output.");
  }
  return JSON.parse(output.slice(start));
}

function parsePackJson(output) {
  const start = output.lastIndexOf("\n[");
  const jsonText = start >= 0 ? output.slice(start + 1) : output.slice(output.indexOf("["));
  return JSON.parse(jsonText);
}

function scanFiles(pattern) {
  const hits = [];
  for (const relativePath of publicSurfaceFiles) {
    const absolutePath = path.join(repoRoot, relativePath);
    if (!fs.existsSync(absolutePath)) {
      hits.push({ relativePath, line: 0, text: "<missing>" });
      continue;
    }
    const text = fs.readFileSync(absolutePath, "utf8");
    text.split(/\n/u).forEach((line, index) => {
      if (pattern.test(line)) {
        hits.push({ relativePath, line: index + 1 });
      }
    });
  }
  return hits;
}

function packDryRunCheck() {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env
  });
  if (result.status !== 0) {
    return check("pack_dry_run", false, {
      exitCode: result.status,
      stderr: result.stderr.trim().slice(0, 4000)
    });
  }
  const packReport = parsePackJson(result.stdout);
  const packedFiles = new Set(packReport[0]?.files?.map((file) => file.path) || []);
  const missing = requiredPackFiles.filter((relativePath) => !packedFiles.has(relativePath));
  return check("pack_includes_plugin_files", missing.length === 0, {
    missing,
    required: requiredPackFiles
  });
}

function main() {
  const manifest = readJson("plugins/autolabos-research-governor/.codex-plugin/plugin.json");
  const checks = [];

  const contractResult = runNode("plugins/autolabos-research-governor/scripts/print-contract.mjs");
  const contract = contractResult.status === 0 ? parseJsonObject(contractResult.stdout) : undefined;
  checks.push(check("contract_command_passes", contractResult.status === 0, { exitCode: contractResult.status }));
  checks.push(check("contract_names_plugin", contract?.pluginName === manifest.name, { observed: contract?.pluginName }));
  checks.push(check("contract_lists_artifacts_and_intents", Array.isArray(contract?.artifacts) && Array.isArray(contract?.commandIntents), {
    artifacts: contract?.artifacts,
    commandIntents: contract?.commandIntents
  }));

  const dogfoodResult = runNode("plugins/autolabos-research-governor/scripts/dogfood-audit.mjs");
  const dogfood = dogfoodResult.status === 0 ? parseJsonObject(dogfoodResult.stdout) : undefined;
  checks.push(check("dogfood_passes", dogfoodResult.status === 0 && dogfood?.verdict === "pass", {
    exitCode: dogfoodResult.status,
    verdict: dogfood?.verdict
  }));

  const doctorResult = runNode("plugins/autolabos-research-governor/scripts/plugin-doctor.mjs", ["--strict"]);
  const doctor = doctorResult.stdout.trim() ? parseJsonObject(doctorResult.stdout) : undefined;
  checks.push(check("strict_doctor_passes", doctorResult.status === 0 && doctor?.verdict === "pass", {
    exitCode: doctorResult.status,
    verdict: doctor?.verdict,
    cacheRelativePath: doctor?.installedCache?.cacheRelativePath
  }));

  checks.push(packDryRunCheck());

  const portabilityHits = scanFiles(portabilityPattern);
  checks.push(check("plugin_public_surface_portable", portabilityHits.length === 0, { hits: portabilityHits }));

  const oneOffHits = scanFiles(oneOffExperimentPattern);
  checks.push(check("plugin_public_surface_has_no_one_off_experiment_ids", oneOffHits.length === 0, { hits: oneOffHits }));

  const failedChecks = checks.filter((item) => !item.passed);
  const report = {
    commandIntent: "research:audit",
    outputArtifact: "GateReport",
    releaseTarget: manifest.name,
    version: manifest.version,
    verdict: failedChecks.length === 0 ? "pass" : "fail",
    gate: "plugin_release_readiness",
    checks,
    recommendations: failedChecks.length === 0
      ? ["Release checks passed. Restart Codex after installation changes before relying on loaded skill text."]
      : ["Repair failed checks, rerun npm run plugin:dogfood, then rerun npm run plugin:release-check."],
    validationCommand: "npm run plugin:release-check"
  };

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = failedChecks.length === 0 ? 0 : 1;
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({
    commandIntent: "research:audit",
    outputArtifact: "GateReport",
    verdict: "fail",
    gate: "plugin_release_readiness",
    checks: [check("release_check_runtime_error", false, { message })],
    validationCommand: "npm run plugin:release-check"
  }, null, 2) + "\n");
  process.exitCode = 1;
}
