#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const pluginRoot = path.resolve(path.dirname(__filename), "..");
const repoRoot = path.resolve(pluginRoot, "..", "..");

const requiredPackFiles = [
  "plugins/autolabos-research-governor/.codex-plugin/plugin.json",
  "plugins/autolabos-research-governor/README.md",
  "plugins/autolabos-research-governor/scripts/dogfood-audit.mjs",
  "plugins/autolabos-research-governor/scripts/plugin-discovery-check.mjs",
  "plugins/autolabos-research-governor/scripts/plugin-doctor.mjs",
  "plugins/autolabos-research-governor/scripts/plugin-release-check.mjs",
  "plugins/autolabos-research-governor/scripts/run-research-intent.mjs",
  "plugins/autolabos-research-governor/scripts/sync-cache.mjs",
  "plugins/autolabos-research-governor/scripts/print-contract.mjs",
  "plugins/autolabos-research-governor/skills/autolabos/SKILL.md"
];

const workflowArtifacts = [
  "ResearchGapMap",
  "TopicPortfolio",
  "TopicProbeDecision",
  "ActiveTopicProbeContract"
];
const projectionArtifacts = ["VenueViabilityReport"];
const venueProjectionContract = {
  authority: "A0_deterministic",
  decisionScope: "active_candidate",
  currentEvidenceCeiling: "screening_only",
  topTierReadinessAllowed: ["blocked", "unresolved"],
  confirmatoryCandidacyAllowed: ["supported", "unsupported", "unresolved"],
  confirmatoryCandidacyIndependentFromTopTierReadiness: true,
  confirmatoryVetoWhenUnsupported: true,
  topTierReady: false,
  acceptanceLikelihoodAssessed: false,
  transitionAuthority: false
};
const workflowNodes = [
  "collect_papers",
  "analyze_papers",
  "generate_hypotheses",
  "design_experiments"
];
const discoveryCandidateContract = [
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

const publicSurfaceFiles = [
  "README.md",
  "docs/architecture.md",
  "docs/codex-plugin-governance.md",
  "docs/reproducibility.md",
  "docs/plugin-production-pilot-acceptance.md",
  "scripts/validate-plugin-bridge-e2e.mjs",
  "scripts/validate-plugin-fault-matrix.mjs",
  "scripts/validate-plugin-hermetic-cache.mjs",
  "scripts/validate-plugin-operations.mjs",
  "scripts/fixtures/autolabos-cli-proxy.mjs",
  "scripts/lib/research-governance-acceptance.mjs",
  "scripts/lib/validation-report.mjs",
  "plugins/autolabos-research-governor/.codex-plugin/plugin.json",
  "plugins/autolabos-research-governor/README.md",
  "plugins/autolabos-research-governor/scripts/dogfood-audit.mjs",
  "plugins/autolabos-research-governor/scripts/plugin-discovery-check.mjs",
  "plugins/autolabos-research-governor/scripts/plugin-doctor.mjs",
  "plugins/autolabos-research-governor/scripts/plugin-release-check.mjs",
  "plugins/autolabos-research-governor/scripts/run-research-intent.mjs",
  "plugins/autolabos-research-governor/scripts/sync-cache.mjs",
  "plugins/autolabos-research-governor/scripts/print-contract.mjs",
  "plugins/autolabos-research-governor/skills/autolabos/SKILL.md",
  "package.json"
];

const posixPrivateRoots = ["home", "Users", "mnt", "tmp"]
  .map((segment) => `${path.posix.sep}${segment}${path.posix.sep}`);
const privateWorkspaceCompounds = [
  ["reference", "vault"],
  ["private", "mirror"]
].map((segments) => segments.join("[-_ ]?"));
const portabilityPattern = new RegExp(
  [...posixPrivateRoots, ...privateWorkspaceCompounds].join("|"),
  "iu"
);

const GENERIC_ENTRYPOINT_TOKENS = new Set([
  "all",
  "analysis",
  "baseline",
  "bounded",
  "candidate",
  "comparison",
  "condition",
  "configured",
  "control",
  "dynamic",
  "experiment",
  "failure",
  "finalize",
  "full",
  "grid",
  "local",
  "locked",
  "ordered",
  "parameterized",
  "planned",
  "primary",
  "public",
  "real",
  "safe",
  "secondary",
  "seed",
  "single",
  "study",
  "sweep",
  "validation",
  "workflow"
]);
const EXPERIMENT_ENTRYPOINT_PATTERN =
  /\b(?:run|execute|orchestrate)_([a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)*)_(?:study|sweep|experiment)\b/gu;
const NUMERIC_CONDITION_PATTERN =
  /\b(?!(?:condition|score)_)[a-z][a-z0-9]*_\d+(?:_\d+)?_(?!to_)[a-z][a-z0-9]*_\d+(?:_\d+)?\b/giu;
const ENCODED_LITERAL_PATTERN =
  /String\.fromCharCode\(\s*\d+(?:\s*,\s*\d+){3,}\s*\)/gu;

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function check(id, passed, details = {}) {
  return { id, passed: Boolean(passed), ...details };
}

function runNode(relativePath, args = []) {
  return spawnSync(process.execPath, [path.join(repoRoot, relativePath), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env
  });
}

function parseJsonObject(output) {
  const start = output.indexOf("{");
  if (start < 0) {
    throw new Error("No JSON object found in command output.");
  }
  return JSON.parse(output.slice(start));
}

function parsePackJson(output) {
  const start = output.lastIndexOf("\n[");
  const jsonText = start >= 0 ? output.slice(start + 1) : output.slice(output.indexOf("["));
  return JSON.parse(jsonText);
}

function scanFiles(pattern) {
  const hits = [];
  for (const relativePath of publicSurfaceFiles) {
    const absolutePath = path.join(repoRoot, relativePath);
    if (!fs.existsSync(absolutePath)) {
      hits.push({ relativePath, line: 0, text: "<missing>" });
      continue;
    }
    const text = fs.readFileSync(absolutePath, "utf8");
    text.split(/\n/u).forEach((line, index) => {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        hits.push({ relativePath, line: index + 1 });
      }
    });
  }
  return hits;
}

function scanExperimentSpecificContracts() {
  const hits = [
    ...scanFiles(NUMERIC_CONDITION_PATTERN).map((hit) => ({
      ...hit,
      kind: "numeric_condition_slug"
    })),
    ...scanFiles(ENCODED_LITERAL_PATTERN).map((hit) => ({
      ...hit,
      kind: "encoded_literal_from_character_codes"
    }))
  ];
  for (const relativePath of publicSurfaceFiles) {
    const absolutePath = path.join(repoRoot, relativePath);
    if (!fs.existsSync(absolutePath)) continue;
    const source = fs.readFileSync(absolutePath, "utf8");
    EXPERIMENT_ENTRYPOINT_PATTERN.lastIndex = 0;
    for (const match of source.matchAll(EXPERIMENT_ENTRYPOINT_PATTERN)) {
      const domainTokens = match[1]
        .split("_")
        .filter((token) => !GENERIC_ENTRYPOINT_TOKENS.has(token));
      if (domainTokens.length === 0) continue;
      hits.push({
        relativePath,
        line: source.slice(0, match.index).split(/\n/u).length,
        kind: "experiment_specific_entrypoint",
        identifier: match[0],
        domainTokens
      });
    }
  }
  return hits;
}

function packDryRunCheck() {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env
  });
  if (result.status !== 0) {
    return check("pack_dry_run", false, {
      exitCode: result.status,
      stderr: result.stderr.trim().slice(0, 4000)
    });
  }
  const packReport = parsePackJson(result.stdout);
  const packedFiles = new Set(packReport[0]?.files?.map((file) => file.path) || []);
  const missing = requiredPackFiles.filter((relativePath) => !packedFiles.has(relativePath));
  return check("pack_includes_plugin_files", missing.length === 0, {
    missing,
    required: requiredPackFiles
  });
}

function main() {
  const manifest = readJson("plugins/autolabos-research-governor/.codex-plugin/plugin.json");
  const checks = [];

  const contractResult = runNode("plugins/autolabos-research-governor/scripts/print-contract.mjs");
  const contract = contractResult.status === 0 ? parseJsonObject(contractResult.stdout) : undefined;
  checks.push(check("contract_command_passes", contractResult.status === 0, { exitCode: contractResult.status }));
  checks.push(check("contract_names_plugin", contract?.pluginName === manifest.name, { observed: contract?.pluginName }));
  checks.push(check("contract_schema_version", contract?.schemaVersion === "3.1", { observed: contract?.schemaVersion }));
  checks.push(check("contract_lists_artifacts_and_intents", Array.isArray(contract?.artifacts)
    && Array.isArray(contract?.workflowArtifacts)
    && workflowArtifacts.every((artifact) => contract.workflowArtifacts.includes(artifact))
    && Array.isArray(contract?.projectionArtifacts)
    && projectionArtifacts.every((artifact) => contract.projectionArtifacts.includes(artifact))
    && Object.entries(venueProjectionContract).every(
      ([key, value]) => JSON.stringify(
        contract?.projectionContracts?.VenueViabilityReport?.[key]
      ) === JSON.stringify(value)
    )
    && Array.isArray(contract?.executableCliIntents)
    && Array.isArray(contract?.workflowIntents), {
    artifacts: contract?.artifacts,
    workflowArtifacts: contract?.workflowArtifacts,
    projectionArtifacts: contract?.projectionArtifacts,
    projectionContracts: contract?.projectionContracts,
    executableCliIntents: contract?.executableCliIntents,
    workflowIntents: contract?.workflowIntents
  }));
  const discoveryIntent = contract?.workflowIntents?.find((intent) => intent?.id === "research:discover");
  checks.push(check("contract_keeps_discovery_workflow_native", discoveryIntent?.executionMode === "workflow_native"
    && discoveryIntent?.addsTopLevelNode === false
    && JSON.stringify(discoveryIntent?.referenceWorkflowNodes) === JSON.stringify(workflowNodes)
    && discoveryIntent?.closedChain?.startArtifact === "ResearchBrief"
    && discoveryIntent?.closedChain?.requiresCompleteStartArtifact === true
    && discoveryIntent?.closedChain?.requiredResearchMode === "topic_discovery"
    && discoveryIntent?.closedChain?.doesNotRequirePreselection?.includes("final_topic")
    && discoveryIntent?.closedChain?.doesNotRequirePreselection?.includes("primary_metric")
    && discoveryIntent?.closedChain?.terminalAuthority === "closed_chain_probe_authorization"
    && discoveryIntent?.closedChain?.doesNotAuthorize?.includes("topic_selection")
    && discoveryIntent?.closedChain?.doesNotAuthorize?.includes("paper_readiness")
    && JSON.stringify(discoveryIntent?.candidateContract) === JSON.stringify(discoveryCandidateContract)
    && JSON.stringify(discoveryIntent?.candidateOptionalFields) === JSON.stringify(["meaningful_effect"])
    && discoveryIntent?.designHandoff?.artifactFilename === "active_topic_probe_contract.json"
    && discoveryIntent?.designHandoff?.activeCandidateCount === 1
    && discoveryIntent?.designHandoff?.hashBindings?.includes("portfolio_content_sha256")
    && discoveryIntent?.designHandoff?.hashBindings?.includes("candidate_content_sha256")
    && discoveryIntent?.designHandoff?.inactiveCandidateDisposition === "deferred"
    && discoveryIntent?.designHandoff?.evidenceStage === "bounded_probe"
    && discoveryIntent?.designHandoff?.paperClaimEvidence === false
    && !contract?.executableCliIntents?.includes("research:discover"), {
    discoveryIntent,
    executableCliIntents: contract?.executableCliIntents
  }));
  checks.push(check(
    "contract_lists_model_review_sidecar",
    Array.isArray(contract?.sidecarArtifacts) && contract.sidecarArtifacts.includes("ModelReviewBundle"),
    { sidecarArtifacts: contract?.sidecarArtifacts }
  ));
  checks.push(check(
    "contract_lists_dependency_operational_artifact",
    Array.isArray(contract?.operationalArtifacts) && contract.operationalArtifacts.includes("PluginDependencyReport"),
    { operationalArtifacts: contract?.operationalArtifacts }
  ));

  const dogfoodResult = runNode("plugins/autolabos-research-governor/scripts/dogfood-audit.mjs");
  const dogfood = dogfoodResult.status === 0 ? parseJsonObject(dogfoodResult.stdout) : undefined;
  checks.push(check("dogfood_passes", dogfoodResult.status === 0 && dogfood?.verdict === "pass", {
    exitCode: dogfoodResult.status,
    verdict: dogfood?.verdict
  }));

  const doctorResult = runNode("plugins/autolabos-research-governor/scripts/plugin-doctor.mjs", ["--strict"]);
  const doctor = doctorResult.stdout.trim() ? parseJsonObject(doctorResult.stdout) : undefined;
  checks.push(check("strict_doctor_passes", doctorResult.status === 0 && doctor?.verdict === "pass", {
    exitCode: doctorResult.status,
    verdict: doctor?.verdict,
    cacheRelativePath: doctor?.installedCache?.cacheRelativePath
  }));

  checks.push(packDryRunCheck());

  const portabilityHits = scanFiles(portabilityPattern);
  checks.push(check("plugin_public_surface_portable", portabilityHits.length === 0, { hits: portabilityHits }));

  const experimentContractHits = scanExperimentSpecificContracts();
  checks.push(check(
    "plugin_public_surface_has_no_encoded_or_experiment_specific_contracts",
    experimentContractHits.length === 0,
    { hits: experimentContractHits }
  ));

  const failedChecks = checks.filter((item) => !item.passed);
  const report = {
    commandIntent: "research:audit",
    outputArtifact: "GateReport",
    releaseTarget: manifest.name,
    version: manifest.version,
    verdict: failedChecks.length === 0 ? "pass" : "fail",
    gate: "plugin_release_readiness",
    checks,
    recommendations: failedChecks.length === 0
      ? ["Release checks passed. Restart Codex after installation changes before relying on loaded skill text."]
      : ["Repair failed checks, rerun npm run plugin:dogfood, then rerun npm run plugin:release-check."],
    validationCommand: "npm run plugin:release-check"
  };

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exitCode = failedChecks.length === 0 ? 0 : 1;
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({
    commandIntent: "research:audit",
    outputArtifact: "GateReport",
    verdict: "fail",
    gate: "plugin_release_readiness",
    checks: [check("release_check_runtime_error", false, { message })],
    validationCommand: "npm run plugin:release-check"
  }, null, 2) + "\n");
  process.exitCode = 1;
}
