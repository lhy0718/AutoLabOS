import { describe, expect, it } from "vitest";

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RESEARCH_GOVERNANCE_COMMANDS } from "../src/core/researchGovernanceContract.js";

const ROOT = process.cwd();
const PLUGIN_ROOT = path.join(ROOT, "plugins", "autolabos-research-governor");
const WORKFLOW_ARTIFACTS = [
  "ResearchGapMap",
  "TopicPortfolio",
  "TopicProbeDecision",
  "ActiveTopicProbeContract"
];
const DISCOVERY_NODES = [
  "collect_papers",
  "analyze_papers",
  "generate_hypotheses",
  "design_experiments"
];
const DISCOVERY_BRIEF_OWNS = [
  "broad_search_scope",
  "resource_limits",
  "evidence_floor",
  "disallowed_shortcuts"
];
const DISCOVERY_PRESELECTION_EXCLUSIONS = [
  "final_topic",
  "primary_metric",
  "metric_unit",
  "metric_scale",
  "metric_direction",
  "effect_criterion",
  "meaningful_effect",
  "comparator",
  "dataset_or_task"
];
const DISCOVERY_CANDIDATE_CONTRACT = [
  "closest_prior_non_overlap",
  "strongest_baseline_absorption_objection",
  "primary_metric",
  "metric_unit",
  "metric_scale",
  "metric_direction",
  "effect_criterion",
  "comparator",
  "dataset_or_task",
  "local_budget",
  "falsifier",
  "kill_signal",
  "minimum_publishable_evidence"
];
const normalizeContractText = (text: string): string => text.replace(/\s+/gu, " ").trim();

describe("AutoLabOS Codex plugin contract", () => {
  it("ships a valid repo-local plugin manifest with skills enabled", () => {
    const manifestPath = path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    expect(manifest.name).toBe("autolabos-research-governor");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(?:\+codex\.[a-z0-9._-]+)?$/u);
    expect(manifest.skills).toBe("./skills/");
    expect(manifest.interface.displayName).toBe("AutoLabOS Research Governor");
    expect(manifest.interface.defaultPrompt).toHaveLength(4);
    expect(manifest.interface.defaultPrompt).toContain(
      "Discover paper topics from a broad governed discovery brief."
    );
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
        "plugin_readme_documents_clean_install",
        "plugin_readme_documents_all_executable_cli_intents",
        "plugin_readme_documents_intent_separation",
        "plugin_readme_documents_discovery_ceiling",
        "plugin_readme_documents_discovery_handoff",
        "skill_documents_workflow_native_discovery",
        "skill_documents_candidate_owned_measurement_contract",
        "skill_documents_single_active_probe_handoff",
        "skill_keeps_discovery_off_cli_bridge",
        "governance_doc_documents_intent_separation",
        "governance_doc_documents_discovery_contract",
        "architecture_doc_preserves_workflow_native_discovery",
        "ci_workflow_runs_operations_preflight",
        "operations_preflight_blocks_partial_promotion",
        "plugin_discovery_checks_local_codex_and_strict_cache",
        "plugin_doctor_reports_cache_alignment",
        "plugin_doctor_supports_strict_mode",
        "plugin_release_check_reports_release_gate",
        "plugin_sync_cache_supports_dry_run_and_write",
        "plugin_bridge_executes_all_cli_intents",
        "plugin_bridge_excludes_workflow_native_discovery",
        "print_contract_separates_cli_and_workflow_intents",
        "print_contract_defines_discovery_closed_chain",
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

  it("documents executable and workflow-native intents in the short public skill", () => {
    const skillPath = path.join(PLUGIN_ROOT, "skills", "autolabos", "SKILL.md");
    const text = fs.readFileSync(skillPath, "utf8");
    const normalized = normalizeContractText(text);

    expect(text).toContain("name: autolabos");
    expect(text).toContain("plugin:dogfood");

    for (const command of RESEARCH_GOVERNANCE_COMMANDS) {
      expect(text).toContain(command.id);
    }

    expect(normalized).toContain("`research:discover` is a workflow-native intent");
    expect(normalized).toContain("not an `autolabos research discover` command");
    expect(normalized).toContain("complete discovery-scoped `ResearchBrief`");
    expect(normalized).toContain("`Research Mode` to `topic_discovery`");
    expect(normalized).toContain("does not require the user to preselect a final topic");
    expect(normalized).toContain("5-7 candidates");
    expect(normalized).toContain("at least 3 distinct nonempty evidence-axis clusters");
    expect(normalized).toContain("strongest-baseline absorption objection");
    expect(normalized).toContain("local budget");
    expect(normalized).toContain("falsifier");
    expect(normalized).toContain("kill signal");
    expect(normalized).toContain("minimum publishable evidence");
    expect(normalized).toContain("closed-chain probe authorization");
    expect(normalized).toContain("not final topic selection");
    for (const field of [
      "`primary_metric`",
      "`metric_unit`",
      "`metric_scale`",
      "`metric_direction`",
      "`effect_criterion`",
      "comparator",
      "dataset/task",
      "falsifier",
      "kill signal",
      "local budget"
    ]) {
      expect(normalized).toContain(field);
    }
    expect(normalized).toContain("exactly one candidate");
    expect(normalized).toContain("`active_topic_probe_contract.json`");
    expect(normalized).toContain("`ActiveTopicProbeContract`");
    expect(normalized).toContain("SHA-256");
    expect(normalized).toContain("explicitly `deferred`");
    expect(normalized).toContain("`bounded_probe`");
    expect(normalized).toContain("not paper claim evidence");
    for (const node of DISCOVERY_NODES) {
      expect(text).toContain(node);
    }
    for (const artifact of WORKFLOW_ARTIFACTS) {
      expect(text).toContain(artifact);
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

  it("prints separate executable CLI and workflow-native discovery contracts", () => {
    const output = execFileSync("node", [
      path.join(PLUGIN_ROOT, "scripts", "print-contract.mjs")
    ], { cwd: ROOT, encoding: "utf8" });
    const contract = JSON.parse(output);
    const executableIds = RESEARCH_GOVERNANCE_COMMANDS.map((command) => command.id);
    const discovery = contract.workflowIntents.find(
      (intent: { id?: string }) => intent.id === "research:discover"
    );

    expect(contract.executableCliIntents).toEqual(executableIds);
    expect(contract.schemaVersion).toBe("3.0");
    expect(contract.commandIntents).toBeUndefined();
    expect(contract.compatibility).toBeUndefined();
    expect(contract.executableCliIntents).not.toContain("research:discover");
    expect(contract.workflowArtifacts).toEqual(WORKFLOW_ARTIFACTS);
    expect(discovery).toMatchObject({
      executionMode: "workflow_native",
      referenceWorkflowNodes: DISCOVERY_NODES,
      addsTopLevelNode: false,
      closedChain: {
        startArtifact: "ResearchBrief",
        requiresCompleteStartArtifact: true,
        requiredResearchMode: "topic_discovery",
        startArtifactOwns: DISCOVERY_BRIEF_OWNS,
        doesNotRequirePreselection: DISCOVERY_PRESELECTION_EXCLUSIONS,
        workflowArtifacts: WORKFLOW_ARTIFACTS,
        terminalAuthority: "closed_chain_probe_authorization",
        doesNotAuthorize: ["topic_selection", "paper_readiness"]
      },
      portfolioPolicy: {
        candidateMinimum: 5,
        candidateMaximum: 7,
        minimumDistinctClusters: 3
      }
    });
    expect(discovery.candidateContract).toEqual(DISCOVERY_CANDIDATE_CONTRACT);
    expect(discovery.candidateOptionalFields).toEqual(["meaningful_effect"]);
    expect(discovery.designHandoff).toEqual({
      artifactClass: "ActiveTopicProbeContract",
      artifactFilename: "active_topic_probe_contract.json",
      activeCandidateCount: 1,
      hashBindings: ["portfolio_content_sha256", "candidate_content_sha256"],
      inactiveCandidateDisposition: "deferred",
      evidenceStage: "bounded_probe",
      paperClaimEvidence: false,
      downstreamResultsPlanBinding: {
        artifactClass: "ResultsPlanV2",
        primaryComparisonField: "primary_comparison_id",
        primaryEffectField: "primary_effect_criterion",
        comparisonMetric: "raw_candidate_metric",
        preserves: [
          "metric_unit",
          "metric_scale",
          "metric_direction",
          "effect_criterion"
        ],
        favorableSubthresholdOutcome: "not_success"
      }
    });
  });

  it("ships first-run plugin onboarding for contract inspection and self-dogfood", () => {
    const readmePath = path.join(PLUGIN_ROOT, "README.md");
    const text = fs.readFileSync(readmePath, "utf8");
    const normalized = normalizeContractText(text);

    expect(text).toContain("## First Run");
    expect(text).toContain("## Installation");
    expect(text).toContain("codex plugin marketplace add .");
    expect(text).toContain("codex plugin add autolabos-research-governor@autolabos-local");
    expect(text).toContain("codex plugin list");
    expect(text).toContain("npm run plugin:contract");
    expect(text).toContain("npm run plugin:dogfood");
    expect(text).toContain("npm run plugin:doctor");
    expect(text).toContain("npm run plugin:doctor -- --strict");
    expect(text).toContain("npm run plugin:sync-cache");
    expect(text).toContain("npm run plugin:release-check");
    expect(text).toContain("npm run plugin:research -- --check");
    expect(text).toContain("docs/codex-plugin-governance.md");
    expect(text).toContain("External outputs remain untrusted evidence");
    expect(text).toContain("PluginDependencyReport");
    expect(text).toContain("## Executable CLI Intents");
    expect(text).toContain("## Workflow-Native Topic Discovery");
    expect(normalized).toContain("`research:discover` is a workflow-native intent");
    expect(normalized).toContain("not a CLI-backed command");
    expect(normalized).toContain("complete discovery-scoped `ResearchBrief`");
    expect(normalized).toContain("`Research Mode` is `topic_discovery`");
    expect(normalized).toContain("does not require the user to preselect the final topic");
    expect(normalized).toContain("5-7 candidates");
    expect(normalized).toContain("at least 3 distinct nonempty evidence-axis clusters");
    expect(normalized).toContain("strongest-baseline absorption objection");
    expect(normalized).toContain("local budget");
    expect(normalized).toContain("falsifier");
    expect(normalized).toContain("kill signal");
    expect(normalized).toContain("minimum publishable evidence");
    expect(normalized).toContain("closed-chain probe authorization");
    expect(normalized).toContain("not topic selection");
    expect(normalized).toContain("`primary_metric`");
    expect(normalized).toContain("`metric_unit`");
    expect(normalized).toContain("`metric_scale`");
    expect(normalized).toContain("`metric_direction`");
    expect(normalized).toContain("`effect_criterion`");
    expect(normalized).toContain("`meaningful_effect`");
    expect(normalized).toContain("exactly one candidate");
    expect(normalized).toContain("`active_topic_probe_contract.json`");
    expect(normalized).toContain("`ActiveTopicProbeContract`");
    expect(normalized).toContain("SHA-256");
    expect(normalized).toContain("explicitly `deferred`");
    expect(normalized).toContain("`bounded_probe`");
    expect(normalized).toContain("not paper claim evidence");

    for (const command of RESEARCH_GOVERNANCE_COMMANDS) {
      expect(text).toContain(command.id);
      expect(text).toContain(command.outputArtifact);
    }
    for (const node of DISCOVERY_NODES) {
      expect(text).toContain(node);
    }
    for (const artifact of WORKFLOW_ARTIFACTS) {
      expect(text).toContain(artifact);
    }
  });

  it("documents discovery as a fixed-workflow artifact chain in public governance docs", () => {
    const governance = fs.readFileSync(
      path.join(ROOT, "docs", "codex-plugin-governance.md"),
      "utf8"
    );
    const architecture = fs.readFileSync(
      path.join(ROOT, "docs", "architecture.md"),
      "utf8"
    );

    for (const text of [governance, architecture]) {
      const normalized = normalizeContractText(text);
      expect(normalized).toContain("research:discover");
      expect(normalized).toContain("complete `ResearchBrief`");
      expect(normalized).toContain("5-7 candidates");
      expect(normalized).toContain("at least 3 distinct nonempty evidence-axis clusters");
      expect(normalized).toContain("strongest-baseline absorption objection");
      expect(normalized).toContain("local budget");
      expect(normalized).toContain("falsifier");
      expect(normalized).toContain("kill signal");
      expect(normalized).toContain("minimum publishable evidence");
      expect(normalized).toContain("closed-chain probe authorization");
      expect(normalized).toContain("not final topic selection");
      expect(normalized).toContain("paper readiness");
      for (const node of DISCOVERY_NODES) {
        expect(text).toContain(node);
      }
      for (const artifact of WORKFLOW_ARTIFACTS) {
        expect(text).toContain(artifact);
      }
    }

    expect(governance).toContain("### Executable CLI Intents");
    expect(governance).toContain("### Workflow-Native Intent");
    expect(governance).toContain("The bridge does not expose `research:discover`");
    expect(architecture).toContain("not as a CLI-backed command or a new top-level node");
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
  process.stdout.write(compatible ? "new audit review improve pack verify-pack verify-milestone\\n" : "new audit review improve\\n");
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

  it("keeps research:discover off the executable CLI bridge", () => {
    const bridge = path.join(PLUGIN_ROOT, "scripts", "run-research-intent.mjs");
    const help = execFileSync(process.execPath, [bridge, "--help"], {
      cwd: ROOT,
      encoding: "utf8"
    });
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autolabos-plugin-workflow-intent-"));
    const fakeCli = path.join(tempRoot, "autolabos-fixture");

    try {
      fs.writeFileSync(fakeCli, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });
      const result = spawnSync(process.execPath, [bridge, "discover"], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, AUTOLABOS_BIN: fakeCli }
      });

      expect(help).not.toContain("discover");
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Unsupported research intent: discover");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("forwards milestone verification through the plugin bridge", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autolabos-plugin-milestone-"));
    const fakeCli = path.join(tempRoot, "autolabos-fixture");
    const source = `#!/usr/bin/env node
process.stdout.write(JSON.stringify(process.argv.slice(2)));
`;

    try {
      fs.writeFileSync(fakeCli, source, { mode: 0o755 });
      const bridge = path.join(PLUGIN_ROOT, "scripts", "run-research-intent.mjs");
      const result = spawnSync(process.execPath, [
        bridge,
        "verify-milestone",
        "--contract",
        "milestone.json",
        "--out-dir",
        "audit"
      ], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, AUTOLABOS_BIN: fakeCli }
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        "research",
        "verify-milestone",
        "--contract",
        "milestone.json",
        "--out-dir",
        "audit"
      ]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("emits a blocking dependency report without fabricating a research gate", () => {
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
    expect(report.artifact_type).toBe("PluginDependencyReport");
    expect(report.check_intent).toBe("plugin:dependency");
    expect(report).not.toHaveProperty("evidence_bundle_id");
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
