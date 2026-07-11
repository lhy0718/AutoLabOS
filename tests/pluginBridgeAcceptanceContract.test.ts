import { describe, expect, it } from "vitest";

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

describe("plugin bridge acceptance contract", () => {
  it("wires the deterministic bridge acceptance after build and before cache-dependent checks", () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");

    expect(packageJson.scripts?.["validate:plugin-bridge"]).toBe(
      "node scripts/validate-plugin-bridge-e2e.mjs"
    );
    expect(packageJson.scripts?.["validate:plugin-bridge:local"]).toBe(
      "node scripts/validate-plugin-bridge-e2e.mjs --installed"
    );
    expect(workflow).toContain("npm run validate:plugin-bridge");
    expect(workflow).not.toContain("npm run validate:plugin-bridge:local");
    expect(workflow.indexOf("npm run build")).toBeLessThan(workflow.indexOf("npm run validate:plugin-bridge"));
    expect(workflow.indexOf("npm run validate:plugin-bridge")).toBeLessThan(
      workflow.indexOf("npm run plugin:sync-cache -- --write")
    );
  });

  it("keeps the fixture adapter generic and delegates assertions to the shared harness", () => {
    const runner = fs.readFileSync(
      path.join(ROOT, "scripts", "validate-plugin-bridge-e2e.mjs"),
      "utf8"
    );
    const proxy = fs.readFileSync(
      path.join(ROOT, "scripts", "fixtures", "autolabos-cli-proxy.mjs"),
      "utf8"
    );

    expect(runner).toContain("runResearchGovernanceAcceptance");
    expect(runner).toContain("plugin_bridge_process_e2e");
    expect(runner).toContain("repo_plugin_bridge_fixture_cli");
    expect(runner).toContain("installed_plugin_cache_bridge");
    expect(runner).toContain("installed_bridge_matches_repo");
    expect(proxy).toContain('path.join(repoRoot, "dist", "cli", "main.js")');
    expect(`${runner}\n${proxy}`).not.toMatch(/(?:\/home\/|\/Users\/|[A-Za-z]:\\\\)/u);
  });
});
