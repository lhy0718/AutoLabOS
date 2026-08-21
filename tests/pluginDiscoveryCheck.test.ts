import { describe, expect, it } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const PLUGIN_ROOT = path.join(ROOT, "plugins", "autolabos-research-governor");
const DISCOVERY_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "plugin-discovery-check.mjs");
const SYNC_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "sync-cache.mjs");

describe("AutoLabOS local Codex plugin discovery", () => {
  it("cross-checks discovery, enablement, version, source, cache, and skill without leaking paths", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"), "utf8")
    );
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autolabos-plugin-discovery-"));
    const tempCodexHome = path.join(tempRoot, "codex-home");
    const fakeCodex = path.join(tempRoot, "codex-fixture");
    const fixtureSource = `#!/usr/bin/env node
const version = process.env.DISCOVERY_VERSION || ${JSON.stringify(manifest.version)};
process.stdout.write([
  ${JSON.stringify("Marketplace `autolabos-local`")},
  ${JSON.stringify(`${manifest.name}@autolabos-local`)} + "  installed, enabled  " + version + "  " + ${JSON.stringify(PLUGIN_ROOT)},
  ""
].join("\\n"));
`;

    try {
      fs.writeFileSync(fakeCodex, fixtureSource, { mode: 0o755 });
      const sync = spawnSync(process.execPath, [SYNC_SCRIPT, "--write"], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, CODEX_HOME: tempCodexHome }
      });
      expect(sync.status).toBe(0);

      const pass = spawnSync(process.execPath, [DISCOVERY_SCRIPT], {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          AUTOLABOS_CODEX_BIN: fakeCodex,
          CODEX_HOME: tempCodexHome
        }
      });
      const passReport = JSON.parse(pass.stdout);

      expect(pass.status).toBe(0);
      expect(passReport.verdict).toBe("pass");
      expect(passReport.gate).toBe("local_codex_plugin_discovery");
      expect(passReport.checks.every((item: { passed: boolean }) => item.passed)).toBe(true);
      expect(JSON.stringify(passReport)).not.toContain(tempRoot);
      expect(JSON.stringify(passReport)).not.toContain(ROOT);

      const mismatch = spawnSync(process.execPath, [DISCOVERY_SCRIPT], {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          AUTOLABOS_CODEX_BIN: fakeCodex,
          CODEX_HOME: tempCodexHome,
          DISCOVERY_VERSION: "0.0.0"
        }
      });
      const mismatchReport = JSON.parse(mismatch.stdout);

      expect(mismatch.status).toBe(1);
      expect(mismatchReport.verdict).toBe("fail");
      expect(mismatchReport.checks).toContainEqual(expect.objectContaining({
        id: "discovered_version_matches_manifest",
        passed: false,
        observedVersion: "0.0.0"
      }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
