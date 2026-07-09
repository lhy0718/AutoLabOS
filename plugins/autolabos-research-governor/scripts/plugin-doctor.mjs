#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const pluginRoot = path.resolve(path.dirname(__filename), "..");
const repoRoot = path.resolve(pluginRoot, "..", "..");
const codexHome = process.env.CODEX_HOME
  ? path.resolve(process.env.CODEX_HOME)
  : path.join(os.homedir(), ".codex");
const args = process.argv.slice(2);
const allowedArgs = new Set(["--strict", "--help", "-h"]);
const unknownArgs = args.filter((arg) => !allowedArgs.has(arg));
const strictMode = args.includes("--strict");

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write("Usage: npm run plugin:doctor -- [--strict]\n");
  process.exit(0);
}

if (unknownArgs.length > 0) {
  process.stderr.write("Unknown plugin:doctor argument: " + unknownArgs.join(", ") + "\n");
  process.exit(2);
}

const repoRelativePluginPath = "plugins/autolabos-research-governor";
const marketplacePath = ".agents/plugins/marketplace.json";
const comparableFiles = [
  ".codex-plugin/plugin.json",
  "scripts/dogfood-audit.mjs",
  "scripts/plugin-doctor.mjs",
  "scripts/plugin-release-check.mjs",
  "scripts/sync-cache.mjs",
  "scripts/print-contract.mjs",
  "skills/autolabos/SKILL.md"
];

function readText(absolutePath) {
  return fs.readFileSync(absolutePath, "utf8");
}

function readJson(absolutePath) {
  return JSON.parse(readText(absolutePath));
}

function exists(absolutePath) {
  return fs.existsSync(absolutePath);
}

function digest(absolutePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
}

function relativeCachePath(marketplaceName, pluginName, version = "<version>") {
  return path.posix.join("plugins", "cache", marketplaceName, pluginName, version);
}

function listVersions(cacheRoot) {
  if (!exists(cacheRoot)) {
    return [];
  }
  return fs.readdirSync(cacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function compareFiles(installedPluginRoot) {
  return comparableFiles.map((relativePath) => {
    const repoFile = path.join(pluginRoot, relativePath);
    const cacheFile = path.join(installedPluginRoot, relativePath);
    const repoExists = exists(repoFile);
    const cacheExists = exists(cacheFile);
    const repoSha256 = repoExists ? digest(repoFile) : null;
    const cacheSha256 = cacheExists ? digest(cacheFile) : null;
    let status = "match";
    if (!repoExists) {
      status = "missing_in_repo";
    } else if (!cacheExists) {
      status = "missing_in_cache";
    } else if (repoSha256 !== cacheSha256) {
      status = "drift";
    }
    return {
      relativePath,
      status,
      repoSha256,
      cacheSha256
    };
  });
}

const manifest = readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
const marketplace = readJson(path.join(repoRoot, marketplacePath));
const marketplaceName = marketplace.name || "autolabos-local";
const cacheRoot = path.join(codexHome, "plugins", "cache", marketplaceName, manifest.name);
const versions = listVersions(cacheRoot);
const exactVersionFound = versions.includes(manifest.version);
const selectedVersion = exactVersionFound ? manifest.version : versions.at(-1) || null;
const selectedPluginRoot = selectedVersion ? path.join(cacheRoot, selectedVersion) : null;
const comparisons = selectedPluginRoot ? compareFiles(selectedPluginRoot) : [];
const driftedFiles = comparisons.filter((item) => item.status !== "match");

let verdict = "pass";
if (!selectedVersion) {
  verdict = "not_installed";
} else if (!exactVersionFound) {
  verdict = "cache_update_required";
} else if (driftedFiles.length > 0) {
  verdict = "cache_update_required";
}

const recommendations = [];
if (verdict === "not_installed") {
  recommendations.push("Install the repo-local plugin from the local marketplace, then restart Codex.");
} else if (verdict === "cache_update_required") {
  recommendations.push("Reinstall the plugin or restart Codex so the installed cache matches the repo-local plugin contract.");
}
recommendations.push("Run npm run plugin:contract and npm run plugin:dogfood after plugin changes.");

const report = {
  commandIntent: "research:audit",
  outputArtifact: "GateReport",
  doctorTarget: manifest.name,
  strictMode,
  verdict,
  gate: "installed_plugin_cache_alignment",
  repoLocal: {
    pluginPath: repoRelativePluginPath,
    manifestName: manifest.name,
    version: manifest.version,
    comparableFiles
  },
  installedCache: {
    codexHomeSource: process.env.CODEX_HOME ? "CODEX_HOME" : "default_home",
    cacheRelativePath: relativeCachePath(marketplaceName, manifest.name, selectedVersion || "<version>"),
    status: selectedVersion ? "found" : "not_found",
    exactVersionFound,
    selectedVersion,
    availableVersionCount: versions.length,
    comparisons
  },
  recommendations
};

process.stdout.write(JSON.stringify(report, null, 2) + "\n");

if (strictMode && verdict !== "pass") {
  process.exitCode = 1;
}
