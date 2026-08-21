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

function normalizeWhitespace(text) {
  return text.replace(/\s+/gu, " ").trim();
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
  if (id.startsWith("architecture_doc_")) {
    return "docs/architecture.md";
  }
  if (id.startsWith("ci_workflow_")) {
    return ".github/workflows/ci.yml";
  }
  if (id.startsWith("plugin_discovery_")) {
    return "plugins/autolabos-research-governor/scripts/plugin-discovery-check.mjs";
  }
  if (id.startsWith("plugin_doctor_")) {
    return "plugins/autolabos-research-governor/scripts/plugin-doctor.mjs";
  }
  if (id.startsWith("plugin_release_")) {
    return "plugins/autolabos-research-governor/scripts/plugin-release-check.mjs";
  }
  if (id.startsWith("plugin_sync_")) {
    return "plugins/autolabos-research-governor/scripts/sync-cache.mjs";
  }
  if (id.startsWith("operations_preflight_") || id.startsWith("fault_matrix_") || id.startsWith("hermetic_acceptance_") || id.startsWith("report_retention_")) {
    return "docs/plugin-production-pilot-acceptance.md";
  }
  if (id.startsWith("bridge_acceptance_")) {
    return "scripts/validate-plugin-bridge-e2e.mjs";
  }
  if (id.startsWith("plugin_bridge_")) {
    return "plugins/autolabos-research-governor/scripts/run-research-intent.mjs";
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
const architectureDocText = readText("docs/architecture.md");
const skillContractText = normalizeWhitespace(skillText);
const pluginReadmeContractText = normalizeWhitespace(pluginReadmeText);
const governanceContractText = normalizeWhitespace(governanceDocText);
const architectureContractText = normalizeWhitespace(architectureDocText);
const ciWorkflowText = readOptionalText(".github/workflows/ci.yml");
const contractSource = readText("src/core/researchGovernanceContract.ts");
const packageJson = readJson("package.json");
const printContractSource = readText("plugins/autolabos-research-governor/scripts/print-contract.mjs");
const pluginDiscoverySource = readText("plugins/autolabos-research-governor/scripts/plugin-discovery-check.mjs");
const pluginDoctorSource = readText("plugins/autolabos-research-governor/scripts/plugin-doctor.mjs");
const pluginReleaseCheckSource = readText("plugins/autolabos-research-governor/scripts/plugin-release-check.mjs");
const pluginSyncCacheSource = readText("plugins/autolabos-research-governor/scripts/sync-cache.mjs");
const pluginBridgeSource = readText("plugins/autolabos-research-governor/scripts/run-research-intent.mjs");
const bridgeAcceptanceSource = readText("scripts/validate-plugin-bridge-e2e.mjs");
const bridgeProxySource = readText("scripts/fixtures/autolabos-cli-proxy.mjs");
const acceptanceHarnessSource = readText("scripts/lib/research-governance-acceptance.mjs");
const validationReportSource = readText("scripts/lib/validation-report.mjs");
const faultMatrixSource = readText("scripts/validate-plugin-fault-matrix.mjs");
const hermeticAcceptanceSource = readText("scripts/validate-plugin-hermetic-cache.mjs");
const operationsPreflightSource = readText("scripts/validate-plugin-operations.mjs");
const pilotAcceptanceDoc = readText("docs/plugin-production-pilot-acceptance.md");
const printedContract = JSON.parse(execFileSync(process.execPath, [
  path.join(repoRoot, "plugins/autolabos-research-governor/scripts/print-contract.mjs")
], { cwd: repoRoot, encoding: "utf8" }));
const pluginBridgeHelp = execFileSync(process.execPath, [
  path.join(repoRoot, "plugins/autolabos-research-governor/scripts/run-research-intent.mjs"),
  "--help"
], { cwd: repoRoot, encoding: "utf8" });

const executableCliIntents = [...contractSource.matchAll(/id: "(research:[a-z]+)"/g)].map((match) => match[1]);
const artifactNames = [
  "ResearchBrief",
  "EvidenceBundle",
  "GateReport",
  "ReviewReport",
  "MetaHarnessPatchPlan",
  "PaperReadinessBundle"
];
const workflowArtifactNames = [
  "ResearchGapMap",
  "TopicPortfolio",
  "TopicProbeDecision",
  "ActiveTopicProbeContract"
];
const sidecarArtifactNames = ["ModelReviewBundle"];
const operationalArtifactNames = ["PluginDependencyReport"];
const workflowNodes = [
  "collect_papers",
  "analyze_papers",
  "generate_hypotheses",
  "design_experiments"
];
const workflowCandidateContract = [
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
const discoveryBriefOwns = [
  "broad_search_scope",
  "resource_limits",
  "evidence_floor",
  "disallowed_shortcuts"
];
const discoveryPreselectionExclusions = [
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
const activeProbeHashBindings = [
  "portfolio_content_sha256",
  "candidate_content_sha256"
];
const discoveryIntent = Array.isArray(printedContract.workflowIntents)
  ? printedContract.workflowIntents.find((intent) => intent?.id === "research:discover")
  : undefined;

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
  check("manifest_default_prompts_cover_core_intents", ["brief", "discover", "broad", "audit", "strengthen"].every((term) => defaultPromptText.includes(term)), {
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
  check("skill_documents_all_executable_cli_intents", executableCliIntents.length > 0 && executableCliIntents.every((id) => skillText.includes(id)), {
    executableCliIntents
  }),
  check("skill_documents_workflow_native_discovery", skillContractText.includes("`research:discover` is a workflow-native intent")
    && skillContractText.includes("complete discovery-scoped `ResearchBrief`")
    && skillContractText.includes("`Research Mode` to `topic_discovery`")
    && skillContractText.includes("does not require the user to preselect a final topic")
    && workflowNodes.every((node) => skillText.includes(node))
    && workflowArtifactNames.every((artifact) => skillText.includes(artifact))
    && skillContractText.includes("5-7 candidates")
    && skillContractText.includes("at least 3 distinct nonempty evidence-axis clusters")
    && skillContractText.includes("strongest-baseline absorption objection")
    && skillContractText.includes("local budget")
    && skillContractText.includes("falsifier")
    && skillContractText.includes("kill signal")
    && skillContractText.includes("minimum publishable evidence")
    && skillContractText.includes("closed-chain probe authorization")
    && skillContractText.includes("not final topic selection")
    && skillContractText.includes("paper readiness")),
  check("skill_documents_candidate_owned_measurement_contract", [
    "`primary_metric`",
    "`metric_unit`",
    "`metric_scale`",
    "`metric_direction`",
    "`effect_criterion`",
    "`meaningful_effect`",
    "comparator",
    "dataset/task",
    "falsifier",
    "kill signal",
    "local budget"
  ].every((term) => skillContractText.includes(term))),
  check("skill_documents_single_active_probe_handoff", skillContractText.includes("exactly one candidate")
    && skillContractText.includes("`active_topic_probe_contract.json`")
    && skillContractText.includes("`ActiveTopicProbeContract`")
    && skillContractText.includes("SHA-256")
    && skillContractText.includes("explicitly `deferred`")
    && skillContractText.includes("`bounded_probe`")
    && skillContractText.includes("not paper claim evidence")),
  check("skill_documents_results_plan_effect_binding", skillContractText.includes("`ResultsPlanV2.primary_comparison_id`")
    && skillContractText.includes("`ResultsPlanV2.primary_effect_criterion`")
    && skillContractText.includes("sub-threshold delta")),
  check("skill_keeps_discovery_off_cli_bridge", skillContractText.includes("not an `autolabos research discover` command")
    && skillContractText.includes("must not be routed through `scripts/run-research-intent.mjs`")),
  check("skill_documents_first_run_orientation", skillText.includes("npm run plugin:contract") && skillText.includes("plugin-contract coherence")),
  check("skill_documents_doctor", skillText.includes("npm run plugin:doctor") && skillText.includes("installed Codex plugin cache") && skillText.includes("--strict")),
  check("skill_documents_release_check", skillText.includes("npm run plugin:release-check") && skillText.includes("npm run plugin:sync-cache")),
  check("skill_documents_bridge_acceptance", skillText.includes("npm run validate:plugin-bridge") && skillText.includes("npm run validate:plugin-bridge:local")),
  check("skill_documents_operations_preflight", skillText.includes("npm run validate:plugin-faults") && skillText.includes("npm run validate:plugin-hermetic") && skillText.includes("npm run validate:plugin-operations") && skillText.includes("npm run validate:plugin-operations:local")),
  check("skill_documents_self_dogfood", skillText.includes("dogfood") && skillText.includes("plugin:dogfood")),
  check("plugin_readme_exists", pluginReadmeText.length > 0),
  check("plugin_readme_documents_clean_install", pluginReadmeText.includes("## Installation")
    && pluginReadmeText.includes("codex plugin marketplace add .")
    && pluginReadmeText.includes("codex plugin add autolabos-research-governor@autolabos-local")
    && pluginReadmeText.includes("codex plugin list")),
  check("plugin_readme_documents_first_run", pluginReadmeText.includes("## First Run") && pluginReadmeText.includes("npm run plugin:contract") && pluginReadmeText.includes("npm run plugin:dogfood") && pluginReadmeText.includes("npm run plugin:doctor") && pluginReadmeText.includes("--strict") && pluginReadmeText.includes("npm run plugin:release-check") && pluginReadmeText.includes("npm run plugin:sync-cache")),
  check("plugin_readme_documents_operations_preflight", pluginReadmeText.includes("npm run validate:plugin-faults") && pluginReadmeText.includes("npm run validate:plugin-hermetic") && pluginReadmeText.includes("npm run validate:plugin-operations") && pluginReadmeText.includes("atomic portable JSON report")),
  check("plugin_readme_documents_bridge_acceptance", pluginReadmeText.includes("npm run validate:plugin-bridge") && pluginReadmeText.includes("npm run validate:plugin-bridge:local") && pluginReadmeText.includes("workstation acceptance gate")),
  check("plugin_readme_documents_doctor", pluginReadmeText.includes("installed Codex plugin cache") && pluginReadmeText.includes("repo-local plugin contract") && pluginReadmeText.includes("--strict")),
  check("plugin_readme_documents_release_check", pluginReadmeText.includes("contract, dogfood, strict doctor, pack") && pluginReadmeText.includes("-- --write")),
  check("plugin_readme_documents_all_executable_cli_intents", executableCliIntents.length > 0 && executableCliIntents.every((id) => pluginReadmeText.includes(id)), {
    executableCliIntents
  }),
  check("plugin_readme_documents_intent_separation", pluginReadmeText.includes("## Executable CLI Intents")
    && pluginReadmeText.includes("## Workflow-Native Topic Discovery")
    && pluginReadmeText.includes("not a CLI-backed command")
    && pluginReadmeText.includes("Do not invoke")
    && workflowNodes.every((node) => pluginReadmeText.includes(node))),
  check("plugin_readme_documents_all_artifacts", [...artifactNames, ...workflowArtifactNames, "ActiveTopicProbeContract", ...sidecarArtifactNames, ...operationalArtifactNames].every((artifact) => pluginReadmeText.includes(artifact))),
  check("plugin_readme_documents_discovery_ceiling", pluginReadmeContractText.includes("5-7 candidates")
    && pluginReadmeContractText.includes("at least 3 distinct nonempty evidence-axis clusters")
    && pluginReadmeContractText.includes("strongest-baseline absorption objection")
    && pluginReadmeContractText.includes("local budget")
    && pluginReadmeContractText.includes("falsifier")
    && pluginReadmeContractText.includes("kill signal")
    && pluginReadmeContractText.includes("minimum publishable evidence")
    && pluginReadmeContractText.includes("closed-chain probe authorization")
    && pluginReadmeContractText.includes("not topic selection")
    && pluginReadmeContractText.includes("paper readiness")),
  check("plugin_readme_documents_discovery_handoff", pluginReadmeContractText.includes("`Research Mode` is `topic_discovery`")
    && pluginReadmeContractText.includes("does not require the user to preselect the final topic")
    && pluginReadmeContractText.includes("`primary_metric`")
    && pluginReadmeContractText.includes("`metric_unit`")
    && pluginReadmeContractText.includes("`metric_scale`")
    && pluginReadmeContractText.includes("`metric_direction`")
    && pluginReadmeContractText.includes("`effect_criterion`")
    && pluginReadmeContractText.includes("`meaningful_effect`")
    && pluginReadmeContractText.includes("exactly one candidate")
    && pluginReadmeContractText.includes("`active_topic_probe_contract.json`")
    && pluginReadmeContractText.includes("SHA-256")
    && pluginReadmeContractText.includes("explicitly `deferred`")
    && pluginReadmeContractText.includes("`bounded_probe`")
    && pluginReadmeContractText.includes("not paper claim evidence")),
  check("plugin_readme_documents_results_plan_effect_binding", pluginReadmeContractText.includes("`ResultsPlanV2.primary_comparison_id`")
    && pluginReadmeContractText.includes("`ResultsPlanV2.primary_effect_criterion`")
    && pluginReadmeContractText.includes("sub-threshold delta")),
  check("printed_contract_binds_candidate_effect_to_results_plan", discoveryIntent?.designHandoff?.downstreamResultsPlanBinding?.artifactClass === "ResultsPlanV2"
    && discoveryIntent?.designHandoff?.downstreamResultsPlanBinding?.primaryComparisonField === "primary_comparison_id"
    && discoveryIntent?.designHandoff?.downstreamResultsPlanBinding?.primaryEffectField === "primary_effect_criterion"
    && discoveryIntent?.designHandoff?.downstreamResultsPlanBinding?.comparisonMetric === "raw_candidate_metric"
    && discoveryIntent?.designHandoff?.downstreamResultsPlanBinding?.favorableSubthresholdOutcome === "not_success"
    && ["metric_unit", "metric_scale", "metric_direction", "effect_criterion"].every((field) =>
      discoveryIntent?.designHandoff?.downstreamResultsPlanBinding?.preserves?.includes(field))),
  check("governance_doc_documents_all_executable_cli_intents", executableCliIntents.length > 0 && executableCliIntents.every((id) => governanceDocText.includes(id)), {
    executableCliIntents
  }),
  check("governance_doc_documents_all_artifacts", [...artifactNames, ...workflowArtifactNames, ...sidecarArtifactNames, ...operationalArtifactNames].every((artifact) => governanceDocText.includes(artifact))),
  check("governance_doc_documents_intent_separation", governanceDocText.includes("### Executable CLI Intents")
    && governanceDocText.includes("### Workflow-Native Intent")
    && governanceDocText.includes("not a CLI-backed command")
    && governanceDocText.includes("The bridge does not expose `research:discover`")
    && workflowNodes.every((node) => governanceDocText.includes(node))),
  check("governance_doc_documents_discovery_contract", governanceContractText.includes("complete `ResearchBrief`")
    && governanceContractText.includes("5-7 candidates")
    && governanceContractText.includes("at least 3 distinct nonempty evidence-axis clusters")
    && governanceContractText.includes("strongest-baseline absorption objection")
    && governanceContractText.includes("local budget")
    && governanceContractText.includes("falsifier")
    && governanceContractText.includes("kill signal")
    && governanceContractText.includes("minimum publishable evidence")
    && governanceContractText.includes("closed-chain probe authorization")
    && governanceContractText.includes("not final topic selection")
    && governanceContractText.includes("paper readiness")),
  check("architecture_doc_preserves_workflow_native_discovery", architectureContractText.includes("### Workflow-native topic discovery")
    && architectureContractText.includes("not as a CLI-backed command or a new top-level node")
    && workflowNodes.every((node) => architectureDocText.includes(node))
    && workflowArtifactNames.every((artifact) => architectureDocText.includes(artifact))
    && architectureContractText.includes("closed-chain probe authorization")
    && architectureContractText.includes("not final topic selection")
    && architectureContractText.includes("paper readiness")),
  check("governance_doc_documents_self_dogfood", governanceDocText.includes("Self-Dogfood Loop") && governanceDocText.includes("npm run plugin:dogfood")),
  check("governance_doc_documents_doctor", governanceDocText.includes("npm run plugin:doctor") && governanceDocText.includes("installed Codex plugin cache") && governanceDocText.includes("--strict")),
  check("governance_doc_documents_release_check", governanceDocText.includes("npm run plugin:release-check") && governanceDocText.includes("npm run plugin:sync-cache") && governanceDocText.includes("dry-run")),
  check("governance_doc_documents_operations_preflight", governanceDocText.includes("npm run validate:plugin-faults") && governanceDocText.includes("npm run validate:plugin-hermetic") && governanceDocText.includes("npm run validate:plugin-operations") && governanceDocText.includes("partial success")),
  check("governance_doc_documents_bridge_acceptance_boundary", governanceDocText.includes("npm run validate:plugin-bridge") && governanceDocText.includes("npm run validate:plugin-bridge:local") && governanceDocText.includes("workstation-only gate")),
  check("ci_workflow_runs_plugin_release_check", ciWorkflowText.includes("npm run plugin:sync-cache -- --write") && ciWorkflowText.includes("npm run plugin:release-check")),
  check("ci_workflow_runs_operations_preflight", ciWorkflowText.includes("npm run validate:plugin-operations") && !ciWorkflowText.includes("npm run validate:plugin-operations:local")),
  check("marketplace_entry", Boolean(marketplaceEntry), { marketplace: marketplace.name }),
  check("marketplace_source_is_repo_relative", marketplaceEntry?.source?.source === "local" && marketplaceEntry?.source?.path === "./plugins/autolabos-research-governor", {
    source: marketplaceEntry?.source
  }),
  check("plugin_discovery_checks_local_codex_and_strict_cache", pluginDiscoverySource.includes("local_codex_plugin_discovery") && pluginDiscoverySource.includes('["plugin", "list"]') && pluginDiscoverySource.includes("plugin-doctor.mjs") && pluginDiscoverySource.includes("--strict")),
  check("plugin_doctor_reports_cache_alignment", pluginDoctorSource.includes("installed_plugin_cache_alignment") && pluginDoctorSource.includes("cache_update_required")),
  check("plugin_doctor_supports_strict_mode", pluginDoctorSource.includes("--strict") && pluginDoctorSource.includes("strictMode") && pluginDoctorSource.includes("process.exitCode = 1")),
  check("plugin_release_check_reports_release_gate", pluginReleaseCheckSource.includes("plugin_release_readiness") && pluginReleaseCheckSource.includes("plugin-doctor.mjs") && pluginReleaseCheckSource.includes("--strict") && pluginReleaseCheckSource.includes("pack_includes_plugin_files") && pluginReleaseCheckSource.includes("contract_keeps_discovery_workflow_native")),
  check("plugin_sync_cache_supports_dry_run_and_write", pluginSyncCacheSource.includes("installed_plugin_cache_sync") && pluginSyncCacheSource.includes("--dry-run") && pluginSyncCacheSource.includes("--write")),
  check("report_retention_is_atomic_and_portable", validationReportSource.includes("renameSync") && validationReportSource.includes("PRIVATE_PATH_PATTERN") && validationReportSource.includes("SENSITIVE_ASSIGNMENT_PATTERN")),
  check("fault_matrix_covers_required_failure_classes", ["missing_cli", "cli_contract_mismatch", "missing_cache", "stale_cache_version", "bridge_drift", "schema_mismatch", "non_portable_bundle_content"].every((id) => faultMatrixSource.includes(`"${id}"`))),
  check("hermetic_acceptance_uses_isolated_cache", hermeticAcceptanceSource.includes("temporary_isolated_codex_home") && hermeticAcceptanceSource.includes("hermetic_strict_doctor_passes") && hermeticAcceptanceSource.includes("hermetic_cached_bridge_matches_repo")),
  check("operations_preflight_blocks_partial_promotion", operationsPreflightSource.includes("partialSuccessPromoted: false") && operationsPreflightSource.includes("failedGateCount") && operationsPreflightSource.includes("AUTOLABOS_OPERATIONS_FAIL_GATE")),
  check("pilot_acceptance_matrix_tracks_all_milestones", ["Report retention", "Fault matrix", "Hermetic cache", "Operations preflight"].every((label) => pilotAcceptanceDoc.includes(`| ${label} |`))),
  check("bridge_acceptance_separates_fixture_and_installed_modes", bridgeAcceptanceSource.includes("repo_plugin_bridge_fixture_cli") && bridgeAcceptanceSource.includes("installed_plugin_cache_bridge") && bridgeAcceptanceSource.includes("installed_bridge_matches_repo") && bridgeAcceptanceSource.includes("--installed") && bridgeProxySource.includes("dist") && acceptanceHarnessSource.includes("runResearchGovernanceAcceptance")),
  check("plugin_bridge_executes_all_cli_intents", ["new", "audit", "review", "improve", "pack", "verify-pack", "verify-milestone"].every((intent) => pluginBridgeSource.includes(`"${intent}"`)) && pluginBridgeSource.includes("PluginDependencyReport") && pluginBridgeSource.includes("autolabos_cli_dependency_missing") && pluginBridgeSource.includes('["research", intent')),
  check("plugin_bridge_excludes_workflow_native_discovery", !pluginBridgeSource.includes('"discover"')
    && !pluginBridgeHelp.includes("discover")
    && pluginBridgeHelp.includes("verify-milestone")),
  check("print_contract_lists_artifacts", [...artifactNames, ...workflowArtifactNames, ...sidecarArtifactNames, ...operationalArtifactNames].every((artifact) => printContractSource.includes(artifact))),
  check("print_contract_separates_cli_and_workflow_intents", arraysEqual(printedContract.executableCliIntents, executableCliIntents)
    && printedContract.commandIntents === undefined
    && printedContract.compatibility === undefined
    && !printedContract.executableCliIntents.includes("research:discover")
    && discoveryIntent?.executionMode === "workflow_native"
    && discoveryIntent?.addsTopLevelNode === false
    && arraysEqual(discoveryIntent?.referenceWorkflowNodes, workflowNodes)),
  check("print_contract_defines_discovery_closed_chain", discoveryIntent?.closedChain?.startArtifact === "ResearchBrief"
    && discoveryIntent?.closedChain?.requiresCompleteStartArtifact === true
    && discoveryIntent?.closedChain?.requiredResearchMode === "topic_discovery"
    && arraysEqual(discoveryIntent?.closedChain?.startArtifactOwns, discoveryBriefOwns)
    && arraysEqual(discoveryIntent?.closedChain?.doesNotRequirePreselection, discoveryPreselectionExclusions)
    && arraysEqual(discoveryIntent?.closedChain?.workflowArtifacts, workflowArtifactNames)
    && discoveryIntent?.closedChain?.terminalAuthority === "closed_chain_probe_authorization"
    && arraysEqual(discoveryIntent?.closedChain?.doesNotAuthorize, ["topic_selection", "paper_readiness"])
    && discoveryIntent?.portfolioPolicy?.candidateMinimum === 5
    && discoveryIntent?.portfolioPolicy?.candidateMaximum === 7
    && discoveryIntent?.portfolioPolicy?.minimumDistinctClusters === 3
    && arraysEqual(discoveryIntent?.candidateContract, workflowCandidateContract)
    && arraysEqual(discoveryIntent?.candidateOptionalFields, ["meaningful_effect"])
    && discoveryIntent?.designHandoff?.artifactClass === "ActiveTopicProbeContract"
    && discoveryIntent?.designHandoff?.artifactFilename === "active_topic_probe_contract.json"
    && discoveryIntent?.designHandoff?.activeCandidateCount === 1
    && arraysEqual(discoveryIntent?.designHandoff?.hashBindings, activeProbeHashBindings)
    && discoveryIntent?.designHandoff?.inactiveCandidateDisposition === "deferred"
    && discoveryIntent?.designHandoff?.evidenceStage === "bounded_probe"
    && discoveryIntent?.designHandoff?.paperClaimEvidence === false),
  check("print_contract_outputs_expected_contract", printedContract.pluginName === manifest.name
    && printedContract.primarySurface === "codex_plugin"
    && printedContract.schemaVersion === "3.0"
    && arraysEqual(printedContract.artifacts, artifactNames)
    && arraysEqual(printedContract.workflowArtifacts, workflowArtifactNames)
    && arraysEqual(printedContract.sidecarArtifacts, sidecarArtifactNames)
    && arraysEqual(printedContract.operationalArtifacts, operationalArtifactNames)
    && arraysEqual(printedContract.executableCliIntents, executableCliIntents)
    && typeof printedContract.invariant === "string"
    && printedContract.invariant.includes("untrusted evidence"), {
    observed: printedContract
  }),
  check("package_exposes_operations_validation_scripts", packageJson.scripts?.["validate:plugin-faults"] === "node scripts/validate-plugin-fault-matrix.mjs" && packageJson.scripts?.["validate:plugin-hermetic"] === "node scripts/validate-plugin-hermetic-cache.mjs" && packageJson.scripts?.["validate:plugin-operations"] === "node scripts/validate-plugin-operations.mjs" && packageJson.scripts?.["validate:plugin-operations:local"] === "node scripts/validate-plugin-operations.mjs --local"),
  check("package_exposes_bridge_acceptance_scripts", packageJson.scripts?.["validate:plugin-bridge"] === "node scripts/validate-plugin-bridge-e2e.mjs" && packageJson.scripts?.["validate:plugin-bridge:local"] === "node scripts/validate-plugin-bridge-e2e.mjs --installed", {
    fixture: packageJson.scripts?.["validate:plugin-bridge"],
    installed: packageJson.scripts?.["validate:plugin-bridge:local"]
  }),
  check("package_exposes_contract_script", packageJson.scripts?.["plugin:contract"] === "node plugins/autolabos-research-governor/scripts/print-contract.mjs", {
    observed: packageJson.scripts?.["plugin:contract"]
  }),
  check("package_exposes_discovery_script", packageJson.scripts?.["plugin:discovery-check"] === "node plugins/autolabos-research-governor/scripts/plugin-discovery-check.mjs", {
    observed: packageJson.scripts?.["plugin:discovery-check"]
  }),
  check("package_exposes_doctor_script", packageJson.scripts?.["plugin:doctor"] === "node plugins/autolabos-research-governor/scripts/plugin-doctor.mjs", {
    observed: packageJson.scripts?.["plugin:doctor"]
  }),
  check("package_exposes_release_check_script", packageJson.scripts?.["plugin:release-check"] === "node plugins/autolabos-research-governor/scripts/plugin-release-check.mjs", {
    observed: packageJson.scripts?.["plugin:release-check"]
  }),
  check("package_exposes_sync_cache_script", packageJson.scripts?.["plugin:sync-cache"] === "node plugins/autolabos-research-governor/scripts/sync-cache.mjs", {
    observed: packageJson.scripts?.["plugin:sync-cache"]
  }),
  check("package_exposes_dogfood_script", packageJson.scripts?.["plugin:dogfood"] === "node plugins/autolabos-research-governor/scripts/dogfood-audit.mjs", {
    observed: packageJson.scripts?.["plugin:dogfood"]
  }),
  check("package_exposes_research_bridge_script", packageJson.scripts?.["plugin:research"] === "node plugins/autolabos-research-governor/scripts/run-research-intent.mjs", {
    observed: packageJson.scripts?.["plugin:research"]
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
    "docs/architecture.md",
    ".github/workflows/ci.yml",
    "src/core/researchGovernanceContract.ts",
    "scripts/validate-plugin-bridge-e2e.mjs",
    "scripts/fixtures/autolabos-cli-proxy.mjs",
    "scripts/lib/research-governance-acceptance.mjs",
    "scripts/lib/validation-report.mjs",
    "scripts/validate-plugin-fault-matrix.mjs",
    "scripts/validate-plugin-hermetic-cache.mjs",
    "scripts/validate-plugin-operations.mjs",
    "docs/plugin-production-pilot-acceptance.md",
    "plugins/autolabos-research-governor/scripts/plugin-discovery-check.mjs",
    "plugins/autolabos-research-governor/scripts/plugin-doctor.mjs",
    "plugins/autolabos-research-governor/scripts/plugin-release-check.mjs",
    "plugins/autolabos-research-governor/scripts/run-research-intent.mjs",
    "plugins/autolabos-research-governor/scripts/sync-cache.mjs",
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
