#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const pluginRoot = path.resolve(path.dirname(__filename), "..");
const repoRoot = path.resolve(pluginRoot, "..", "..");
const args = process.argv.slice(2);
const allowedArgs = new Set(["--dry-run", "--write", "--help", "-h"]);
const unknownArgs = args.filter((arg) => !allowedArgs.has(arg));
const writeMode = args.includes("--write");
const dryRun = !writeMode;

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write("Usage: npm run plugin:sync-cache -- [--dry-run|--write]\n");
  process.exit(0);
}

if (unknownArgs.length > 0) {
  process.stderr.write("Unknown plugin:sync-cache argument: " + unknownArgs.join(", ") + "\n");
  process.exit(2);
}

function readJson(absolutePath) {
  return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
}

function listFiles(root, relativeBase = "") {
  const entries = fs.readdirSync(path.join(root, relativeBase), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeBase, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(root, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath.split(path.sep).join(path.posix.sep));
    }
  }
  return files.sort();
}

const manifest = readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
const marketplace = readJson(path.join(repoRoot, ".agents", "plugins", "marketplace.json"));
const marketplaceName = marketplace.name || "autolabos-local";
const codexHome = process.env.CODEX_HOME
  ? path.resolve(process.env.CODEX_HOME)
  : path.join(os.homedir(), ".codex");
const cacheRelativePath = path.posix.join("plugins", "cache", marketplaceName, manifest.name, manifest.version);
const destination = path.join(codexHome, "plugins", "cache", marketplaceName, manifest.name, manifest.version);
const sourceFiles = listFiles(pluginRoot);
const existedBefore = fs.existsSync(destination);

if (writeMode) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(pluginRoot, destination, { recursive: true, force: true, errorOnExist: false });
}

const report = {
  commandIntent: "research:improve",
  outputArtifact: "MetaHarnessPatchPlan",
  syncTarget: manifest.name,
  version: manifest.version,
  dryRun,
  verdict: dryRun ? "would_sync" : "synced",
  gate: "installed_plugin_cache_sync",
  repoLocal: {
    pluginPath: "plugins/autolabos-research-governor",
    fileCount: sourceFiles.length
  },
  installedCache: {
    codexHomeSource: process.env.CODEX_HOME ? "CODEX_HOME" : "default_home",
    cacheRelativePath,
    existedBefore,
    status: writeMode ? "updated" : existedBefore ? "already_present" : "not_present"
  },
  copiedFiles: writeMode ? sourceFiles : [],
  recommendations: writeMode
    ? ["Run npm run plugin:doctor -- --strict and restart Codex before relying on loaded skill text."]
    : ["Rerun with --write to copy the repo-local plugin into the installed Codex plugin cache."],
  validationCommand: dryRun ? "npm run plugin:sync-cache" : "npm run plugin:sync-cache -- --write"
};

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
