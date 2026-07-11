import { describe, expect, it } from "vitest";

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
        "ci_workflow_runs_operations_preflight",
        "operations_preflight_blocks_partial_promotion",
        "plugin_discovery_checks_local_codex_and_strict_cache",
        "plugin_doctor_reports_cache_alignment",
        "plugin_doctor_supports_strict_mode",
        "plugin_release_check_reports_release_gate",
        "plugin_sync_cache_supports_dry_run_and_write",
        "plugin_bridge_executes_all_research_intents",
        "package_exposes_research_bridge_script",
        "ci_workflow_runs_plugin_release_check",
        "print_contract_outputs_expected_contract",
        "package_exposes_contract_script",
        "package_exposes_discovery_script",
        "package_exposes_doctor_script",
        "package_exposes_release_check_script",
        "package_exposes_sync_cache_script"
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
    expect(text).toContain("npm run plugin:contract");
    expect(text).toContain("npm run plugin:dogfood");
    expect(text).toContain("npm run plugin:doctor");
    expect(text).toContain("npm run plugin:doctor -- --strict");
    expect(text).toContain("npm run plugin:sync-cache");
    expect(text).toContain("npm run plugin:release-check");
    expect(text).toContain("npm run plugin:research -- --check");
    expect(text).toContain("docs/codex-plugin-governance.md");
    expect(text).toContain("External outputs remain untrusted evidence");

    for (const command of RESEARCH_GOVERNANCE_COMMANDS) {
      expect(text).toContain(command.id);
      expect(text).toContain(command.outputArtifact);
    }
  });

  it("wires plugin release readiness into CI after syncing the ephemeral cache", () => {
    const workflowPath = path.join(ROOT, ".github", "workflows", "ci.yml");
    const text = fs.readFileSync(workflowPath, "utf8");

    expect(text).toContain("npm run plugin:sync-cache -- --write");
    expect(text).toContain("npm run plugin:release-check");
    expect(text.indexOf("npm run plugin:sync-cache -- --write")).toBeLessThan(
      text.indexOf("npm run plugin:release-check")
    );
  });

  it("distinguishes a CLI contract mismatch from a compatible dependency", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autolabos-plugin-bridge-contract-"));
    const fakeCli = path.join(tempRoot, "autolabos-fixture");
    const source = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("autolabos 9.9.9\\n");
} else if (args[0] === "research" && args[1] === "--help") {
  const compatible = process.env.RESEARCH_HELP_MODE === "compatible";
  process.stdout.write(compatible ? "new audit review improve pack\\n" : "new audit review improve\\n");
} else {
  process.exitCode = 2;
}
`;

    try {
      fs.writeFileSync(fakeCli, source, { mode: 0o755 });
      const bridge = path.join(PLUGIN_ROOT, "scripts", "run-research-intent.mjs");
      const mismatch = spawnSync(process.execPath, [bridge, "--check"], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, AUTOLABOS_BIN: fakeCli }
      });
      const mismatchReport = JSON.parse(mismatch.stdout);
      const compatible = spawnSync(process.execPath, [bridge, "--check"], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, AUTOLABOS_BIN: fakeCli, RESEARCH_HELP_MODE: "compatible" }
      });
      const compatibleReport = JSON.parse(compatible.stdout);

      expect(mismatch.status).toBe(1);
      expect(mismatchReport.verdict).toBe("blocked");
      expect(mismatchReport.findings).toContainEqual(expect.objectContaining({
        code: "autolabos_cli_contract_mismatch"
      }));
      expect(compatible.status).toBe(0);
      expect(compatibleReport.verdict).toBe("pass");
      expect(mismatchReport.artifact_id).not.toBe(compatibleReport.artifact_id);
      expect(JSON.stringify([mismatchReport, compatibleReport])).not.toContain(tempRoot);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("emits a blocking gate report when the executable CLI dependency is unavailable", () => {
    const result = spawnSync(process.execPath, [
      path.join(PLUGIN_ROOT, "scripts", "run-research-intent.mjs"),
      "--check"
    ], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, AUTOLABOS_BIN: "autolabos-command-not-present" }
    });
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(1);
    expect(report.artifact_type).toBe("GateReport");
    expect(report.verdict).toBe("blocked");
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: "autolabos_cli_dependency_missing"
    }));
    expect(JSON.stringify(report)).not.toContain(process.cwd());
  });

  it("fails in strict mode when installed plugin cache is missing", () => {
    const manifestPath = path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const tempCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "autolabos-plugin-doctor-strict-"));

    try {
      const result = spawnSync(process.execPath, [
        path.join(PLUGIN_ROOT, "scripts", "plugin-doctor.mjs"),
        "--strict"
      ], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, CODEX_HOME: tempCodexHome }
      });
      const report = JSON.parse(result.stdout);

      expect(result.status).toBe(1);
      expect(report.doctorTarget).toBe(manifest.name);
      expect(report.strictMode).toBe(true);
      expect(report.verdict).toBe("not_installed");
      expect(JSON.stringify(report)).not.toContain(tempCodexHome);
    } finally {
      fs.rmSync(tempCodexHome, { recursive: true, force: true });
    }
  });

  it("syncs repo-local plugin cache without exposing absolute cache paths", () => {
    const manifestPath = path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const tempCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "autolabos-plugin-sync-cache-"));
    const cacheRoot = path.join(
      tempCodexHome,
      "plugins",
      "cache",
      "autolabos-local",
      manifest.name,
      manifest.version
    );

    try {
      const dryRun = spawnSync(process.execPath, [
        path.join(PLUGIN_ROOT, "scripts", "sync-cache.mjs")
      ], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, CODEX_HOME: tempCodexHome }
      });
      const dryRunReport = JSON.parse(dryRun.stdout);

      expect(dryRun.status).toBe(0);
      expect(dryRunReport.dryRun).toBe(true);
      expect(dryRunReport.verdict).toBe("would_sync");
      expect(dryRunReport.installedCache.cacheRelativePath).toBe(
        path.posix.join("plugins", "cache", "autolabos-local", manifest.name, manifest.version)
      );
      expect(JSON.stringify(dryRunReport)).not.toContain(tempCodexHome);
      expect(fs.existsSync(cacheRoot)).toBe(false);

      const write = spawnSync(process.execPath, [
        path.join(PLUGIN_ROOT, "scripts", "sync-cache.mjs"),
        "--write"
      ], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, CODEX_HOME: tempCodexHome }
      });
      const writeReport = JSON.parse(write.stdout);

      expect(write.status).toBe(0);
      expect(writeReport.dryRun).toBe(false);
      expect(writeReport.verdict).toBe("synced");
      expect(writeReport.copiedFiles).toContain("scripts/sync-cache.mjs");
      expect(writeReport.copiedFiles).toContain("scripts/run-research-intent.mjs");
      expect(JSON.stringify(writeReport)).not.toContain(tempCodexHome);
      expect(fs.existsSync(path.join(cacheRoot, ".codex-plugin", "plugin.json"))).toBe(true);
    } finally {
      fs.rmSync(tempCodexHome, { recursive: true, force: true });
    }
  });

  it("reports installed plugin cache alignment without exposing absolute cache paths", () => {
    const manifestPath = path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const tempCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "autolabos-plugin-doctor-"));
    const cacheRoot = path.join(
      tempCodexHome,
      "plugins",
      "cache",
      "autolabos-local",
      manifest.name,
      manifest.version
    );
    const comparableFiles = [
      ".codex-plugin/plugin.json",
      "scripts/dogfood-audit.mjs",
      "scripts/plugin-discovery-check.mjs",
      "scripts/plugin-doctor.mjs",
      "scripts/plugin-release-check.mjs",
      "scripts/run-research-intent.mjs",
      "scripts/sync-cache.mjs",
      "scripts/print-contract.mjs",
      "skills/autolabos/SKILL.md"
    ];

    try {
      for (const relativePath of comparableFiles) {
        const source = path.join(PLUGIN_ROOT, relativePath);
        const destination = path.join(cacheRoot, relativePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination);
      }

      const output = execFileSync("node", [
        path.join(PLUGIN_ROOT, "scripts", "plugin-doctor.mjs"),
        "--strict"
      ], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, CODEX_HOME: tempCodexHome }
      });
      const report = JSON.parse(output);

      expect(report.commandIntent).toBe("research:audit");
      expect(report.outputArtifact).toBe("GateReport");
      expect(report.gate).toBe("installed_plugin_cache_alignment");
      expect(report.strictMode).toBe(true);
      expect(report.verdict).toBe("pass");
      expect(report.installedCache.cacheRelativePath).toBe(
        path.posix.join("plugins", "cache", "autolabos-local", manifest.name, manifest.version)
      );
      expect(report.installedCache.comparisons.every((item: { status: string }) => item.status === "match")).toBe(true);
      expect(JSON.stringify(report)).not.toContain(tempCodexHome);
    } finally {
      fs.rmSync(tempCodexHome, { recursive: true, force: true });
    }
  });
});
