import { describe, expect, it } from "vitest";

import { execFileSync } from "node:child_process";
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
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(?:\+codex\.[a-z0-9._-]+)?$/u);
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

  it("self-dogfood audit passes and emits a repair-oriented report", () => {
    const output = execFileSync("node", [
      path.join(PLUGIN_ROOT, "scripts", "dogfood-audit.mjs")
    ], { cwd: ROOT, encoding: "utf8" });
    const report = JSON.parse(output);

    expect(report.commandIntent).toBe("research:improve");
    expect(report.outputArtifact).toBe("MetaHarnessPatchPlan");
    expect(report.verdict).toBe("pass");
    expect(report.validationCommand).toBe("npm run plugin:dogfood");
    expect(report.checks.every((item: { passed: boolean }) => item.passed)).toBe(true);
    expect(report.checkedArtifacts).toContain("plugins/autolabos-research-governor/README.md");
    expect(report.checkedArtifacts).toContain("docs/codex-plugin-governance.md");
    expect(report.checks.map((item: { id: string }) => item.id)).toEqual(
      expect.arrayContaining([
        "plugin_readme_documents_first_run",
        "plugin_readme_documents_all_command_intents",
        "print_contract_outputs_expected_contract"
      ])
    );
  });

  it("documents every plugin command intent in the skill", () => {
    const skillPath = path.join(PLUGIN_ROOT, "skills", "autolabos", "SKILL.md");
    const text = fs.readFileSync(skillPath, "utf8");

    expect(text).toContain("name: autolabos");
    expect(text).toContain("plugin:dogfood");

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

  it("ships first-run plugin onboarding for contract inspection and self-dogfood", () => {
    const readmePath = path.join(PLUGIN_ROOT, "README.md");
    const text = fs.readFileSync(readmePath, "utf8");

    expect(text).toContain("## First Run");
    expect(text).toContain("node plugins/autolabos-research-governor/scripts/print-contract.mjs");
    expect(text).toContain("npm run plugin:dogfood");
    expect(text).toContain("docs/codex-plugin-governance.md");
    expect(text).toContain("External outputs remain untrusted evidence");

    for (const command of RESEARCH_GOVERNANCE_COMMANDS) {
      expect(text).toContain(command.id);
      expect(text).toContain(command.outputArtifact);
    }
  });
});
