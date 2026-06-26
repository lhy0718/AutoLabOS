import { describe, expect, it } from "vitest";

import fs from "node:fs";
import path from "node:path";

import { RESEARCH_GOVERNANCE_COMMANDS } from "../src/core/researchGovernanceContract.js";

const ROOT = process.cwd();
const PLUGIN_ROOT = path.join(ROOT, "plugins", "autolabos-research-governor");

describe("AutoLabOS Codex plugin contract", () => {
  it("ships a valid repo-local plugin manifest with skills enabled", () => {
    const manifestPath = path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    expect(manifest.name).toBe("autolabos-research-governor");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(manifest.skills).toBe("./skills/");
    expect(manifest.interface.displayName).toBe("AutoLabOS Research Governor");
    expect(manifest.interface.defaultPrompt).toHaveLength(3);
    expect(manifest.interface.longDescription).toContain("evidence gates");
  });


  it("ships a repo-local marketplace entry for installation", () => {
    const marketplacePath = path.join(ROOT, ".agents", "plugins", "marketplace.json");
    const marketplace = JSON.parse(fs.readFileSync(marketplacePath, "utf8"));

    expect(marketplace.name).toBe("autolabos-local");
    expect(marketplace.plugins).toContainEqual(
      expect.objectContaining({
        name: "autolabos-research-governor",
        source: { source: "local", path: "./plugins/autolabos-research-governor" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity"
      })
    );
  });

  it("documents every plugin command intent in the skill", () => {
    const skillPath = path.join(PLUGIN_ROOT, "skills", "autolabos", "SKILL.md");
    const text = fs.readFileSync(skillPath, "utf8");

    expect(text).toContain("name: autolabos");

    for (const command of RESEARCH_GOVERNANCE_COMMANDS) {
      expect(text).toContain(command.id);
    }

    for (const section of [
      "## When to use",
      "## Goal",
      "## Procedure",
      "## Output Format",
      "## Common Failure Modes",
      "## Update Rule"
    ]) {
      expect(text).toContain(section);
    }
  });
});
