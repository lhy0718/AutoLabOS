#!/usr/bin/env node

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

function check(id, passed, details = {}) {
  return { id, passed: Boolean(passed), ...details };
}

const manifest = readJson("plugins/autolabos-research-governor/.codex-plugin/plugin.json");
const marketplace = readJson(".agents/plugins/marketplace.json");
const skillText = readText("plugins/autolabos-research-governor/skills/autolabos/SKILL.md");
const contractSource = readText("src/core/researchGovernanceContract.ts");
const packageJson = readJson("package.json");
const printContractSource = readText("plugins/autolabos-research-governor/scripts/print-contract.mjs");

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

const checks = [
  check("manifest_name", manifest.name === "autolabos-research-governor", { observed: manifest.name }),
  check("manifest_skills_enabled", manifest.skills === "./skills/", { observed: manifest.skills }),
  check("manifest_has_codex_cachebuster", typeof manifest.version === "string" && manifest.version.includes("+codex."), { observed: manifest.version }),
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
  check("skill_documents_self_dogfood", skillText.includes("dogfood") && skillText.includes("plugin:dogfood")),
  check("marketplace_entry", Boolean(marketplaceEntry), { marketplace: marketplace.name }),
  check("marketplace_source_is_repo_relative", marketplaceEntry?.source?.source === "local" && marketplaceEntry?.source?.path === "./plugins/autolabos-research-governor", {
    source: marketplaceEntry?.source
  }),
  check("print_contract_lists_artifacts", artifactNames.every((artifact) => printContractSource.includes(artifact))),
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
    ".agents/plugins/marketplace.json",
    "src/core/researchGovernanceContract.ts",
    "plugins/autolabos-research-governor/scripts/print-contract.mjs",
    "package.json"
  ],
  checks,
  patchPlan: failedChecks.map((item) => ({
    target: item.id.startsWith("skill_") ? "plugins/autolabos-research-governor/skills/autolabos/SKILL.md" : "plugin_contract_surface",
    reason: item.id,
    action: "Repair the smallest plugin-local artifact and rerun npm run plugin:dogfood."
  })),
  validationCommand: "npm run plugin:dogfood"
};

process.stdout.write(`${JSON.stringify(report, null, 2)}
`);
process.exitCode = failedChecks.length === 0 ? 0 : 1;
