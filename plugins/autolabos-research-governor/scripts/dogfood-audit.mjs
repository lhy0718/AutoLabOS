#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const pluginRoot = path.resolve(path.dirname(__filename), "..");
const repoRoot = path.resolve(pluginRoot, "..", "..");

function readText(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function readOptionalText(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  return fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : "";
}

function arraysEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((item, index) => item === right[index]);
}

function check(id, passed, details = {}) {
  return { id, passed: Boolean(passed), ...details };
}

function repairTarget(id) {
  if (id.startsWith("manifest_")) {
    return "plugins/autolabos-research-governor/.codex-plugin/plugin.json";
  }
  if (id.startsWith("skill_")) {
    return "plugins/autolabos-research-governor/skills/autolabos/SKILL.md";
  }
  if (id.startsWith("marketplace_")) {
    return ".agents/plugins/marketplace.json";
  }
  if (id.startsWith("plugin_readme_")) {
    return "plugins/autolabos-research-governor/README.md";
  }
  if (id.startsWith("governance_doc_")) {
    return "docs/codex-plugin-governance.md";
  }
  if (id.startsWith("plugin_doctor_")) {
    return "plugins/autolabos-research-governor/scripts/plugin-doctor.mjs";
  }
  if (id.startsWith("print_contract_")) {
    return "plugins/autolabos-research-governor/scripts/print-contract.mjs";
  }
  if (id.startsWith("package_")) {
    return "package.json";
  }
  return "plugin_contract_surface";
}

const manifest = readJson("plugins/autolabos-research-governor/.codex-plugin/plugin.json");
const marketplace = readJson(".agents/plugins/marketplace.json");
const skillText = readText("plugins/autolabos-research-governor/skills/autolabos/SKILL.md");
const pluginReadmeText = readOptionalText("plugins/autolabos-research-governor/README.md");
const governanceDocText = readText("docs/codex-plugin-governance.md");
const contractSource = readText("src/core/researchGovernanceContract.ts");
const packageJson = readJson("package.json");
const printContractSource = readText("plugins/autolabos-research-governor/scripts/print-contract.mjs");
const pluginDoctorSource = readText("plugins/autolabos-research-governor/scripts/plugin-doctor.mjs");
const printedContract = JSON.parse(execFileSync(process.execPath, [
  path.join(repoRoot, "plugins/autolabos-research-governor/scripts/print-contract.mjs")
], { cwd: repoRoot, encoding: "utf8" }));

const commandIntents = [...contractSource.matchAll(/id: "(research:[a-z]+)"/g)].map((match) => match[1]);
const artifactNames = [
  "ResearchBrief",
  "EvidenceBundle",
  "GateReport",
  "ReviewReport",
  "MetaHarnessPatchPlan",
  "PaperReadinessBundle"
];

const marketplaceEntry = Array.isArray(marketplace.plugins)
  ? marketplace.plugins.find((entry) => entry && entry.name === manifest.name)
  : undefined;
const defaultPromptText = Array.isArray(manifest.interface?.defaultPrompt)
  ? manifest.interface.defaultPrompt.join(" ").toLowerCase()
  : "";

const checks = [
  check("manifest_name", manifest.name === "autolabos-research-governor", { observed: manifest.name }),
  check("manifest_skills_enabled", manifest.skills === "./skills/", { observed: manifest.skills }),
  check("manifest_has_codex_cachebuster", typeof manifest.version === "string" && manifest.version.includes("+codex."), { observed: manifest.version }),
  check("manifest_default_prompts_cover_core_intents", ["brief", "audit", "strengthen"].every((term) => defaultPromptText.includes(term)), {
    observed: manifest.interface?.defaultPrompt
  }),
  check("skill_short_name", /^name:\s*autolabos$/m.test(skillText)),
  check("skill_has_required_sections", [
    "## When to use",
    "## Goal",
    "## Procedure",
    "## Output Format",
    "## Common Failure Modes",
    "## Update Rule"
  ].every((section) => skillText.includes(section))),
  check("skill_documents_all_command_intents", commandIntents.length > 0 && commandIntents.every((id) => skillText.includes(id)), {
    commandIntents
  }),
  check("skill_documents_first_run_orientation", skillText.includes("npm run plugin:contract") && skillText.includes("plugin-contract coherence")),
  check("skill_documents_doctor", skillText.includes("npm run plugin:doctor") && skillText.includes("installed Codex plugin cache") && skillText.includes("--strict")),
  check("skill_documents_self_dogfood", skillText.includes("dogfood") && skillText.includes("plugin:dogfood")),
  check("plugin_readme_exists", pluginReadmeText.length > 0),
  check("plugin_readme_documents_first_run", pluginReadmeText.includes("## First Run") && pluginReadmeText.includes("npm run plugin:contract") && pluginReadmeText.includes("npm run plugin:dogfood") && pluginReadmeText.includes("npm run plugin:doctor") && pluginReadmeText.includes("--strict")),
  check("plugin_readme_documents_doctor", pluginReadmeText.includes("installed Codex plugin cache") && pluginReadmeText.includes("repo-local plugin contract") && pluginReadmeText.includes("--strict")),
  check("plugin_readme_documents_all_command_intents", commandIntents.length > 0 && commandIntents.every((id) => pluginReadmeText.includes(id)), {
    commandIntents
  }),
  check("plugin_readme_documents_all_artifacts", artifactNames.every((artifact) => pluginReadmeText.includes(artifact))),
  check("governance_doc_documents_all_command_intents", commandIntents.length > 0 && commandIntents.every((id) => governanceDocText.includes(id)), {
    commandIntents
  }),
  check("governance_doc_documents_all_artifacts", artifactNames.every((artifact) => governanceDocText.includes(artifact))),
  check("governance_doc_documents_self_dogfood", governanceDocText.includes("Self-Dogfood Loop") && governanceDocText.includes("npm run plugin:dogfood")),
  check("governance_doc_documents_doctor", governanceDocText.includes("npm run plugin:doctor") && governanceDocText.includes("installed Codex plugin cache") && governanceDocText.includes("--strict")),
  check("marketplace_entry", Boolean(marketplaceEntry), { marketplace: marketplace.name }),
  check("marketplace_source_is_repo_relative", marketplaceEntry?.source?.source === "local" && marketplaceEntry?.source?.path === "./plugins/autolabos-research-governor", {
    source: marketplaceEntry?.source
  }),
  check("plugin_doctor_reports_cache_alignment", pluginDoctorSource.includes("installed_plugin_cache_alignment") && pluginDoctorSource.includes("cache_update_required")),
  check("plugin_doctor_supports_strict_mode", pluginDoctorSource.includes("--strict") && pluginDoctorSource.includes("strictMode") && pluginDoctorSource.includes("process.exitCode = 1")),
  check("print_contract_lists_artifacts", artifactNames.every((artifact) => printContractSource.includes(artifact))),
  check("print_contract_outputs_expected_contract", printedContract.pluginName === manifest.name
    && printedContract.primarySurface === "codex_plugin"
    && arraysEqual(printedContract.artifacts, artifactNames)
    && arraysEqual(printedContract.commandIntents, commandIntents)
    && typeof printedContract.invariant === "string"
    && printedContract.invariant.includes("untrusted evidence"), {
    observed: printedContract
  }),
  check("package_exposes_contract_script", packageJson.scripts?.["plugin:contract"] === "node plugins/autolabos-research-governor/scripts/print-contract.mjs", {
    observed: packageJson.scripts?.["plugin:contract"]
  }),
  check("package_exposes_doctor_script", packageJson.scripts?.["plugin:doctor"] === "node plugins/autolabos-research-governor/scripts/plugin-doctor.mjs", {
    observed: packageJson.scripts?.["plugin:doctor"]
  }),
  check("package_exposes_dogfood_script", packageJson.scripts?.["plugin:dogfood"] === "node plugins/autolabos-research-governor/scripts/dogfood-audit.mjs", {
    observed: packageJson.scripts?.["plugin:dogfood"]
  })
];

const failedChecks = checks.filter((item) => !item.passed);
const report = {
  commandIntent: "research:improve",
  outputArtifact: "MetaHarnessPatchPlan",
  dogfoodTarget: "autolabos-research-governor",
  verdict: failedChecks.length === 0 ? "pass" : "repair_required",
  gate: "self_dogfood_plugin_contract",
  checkedArtifacts: [
    "plugins/autolabos-research-governor/.codex-plugin/plugin.json",
    "plugins/autolabos-research-governor/skills/autolabos/SKILL.md",
    "plugins/autolabos-research-governor/README.md",
    ".agents/plugins/marketplace.json",
    "docs/codex-plugin-governance.md",
    "src/core/researchGovernanceContract.ts",
    "plugins/autolabos-research-governor/scripts/plugin-doctor.mjs",
    "plugins/autolabos-research-governor/scripts/print-contract.mjs",
    "package.json"
  ],
  checks,
  patchPlan: failedChecks.map((item) => ({
    target: repairTarget(item.id),
    reason: item.id,
    action: "Repair the smallest plugin-local artifact and rerun npm run plugin:dogfood."
  })),
  validationCommand: "npm run plugin:dogfood"
};

process.stdout.write(`${JSON.stringify(report, null, 2)}
`);
process.exitCode = failedChecks.length === 0 ? 0 : 1;
