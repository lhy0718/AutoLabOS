#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..", "..");
const cliPath = path.join(repoRoot, "dist", "cli", "main.js");

if (!fs.existsSync(cliPath)) {
  process.stderr.write("Built AutoLabOS CLI not found. Run npm run build first.\n");
  process.exit(1);
}

const result = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: process.env
});

if (result.error) {
  process.stderr.write("Unable to execute the built AutoLabOS CLI.\n");
  process.exitCode = 1;
} else if (result.signal) {
  process.stderr.write(`Built AutoLabOS CLI terminated by signal ${result.signal}.\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
