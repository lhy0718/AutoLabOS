#!/usr/bin/env node

const contract = {
  pluginName: "autolabos-research-governor",
  schemaVersion: "2.0",
  primarySurface: "codex_plugin",
  standaloneWorkflowRole: "reference_workflow",
  artifacts: [
    "ResearchBrief",
    "EvidenceBundle",
    "GateReport",
    "ReviewReport",
    "MetaHarnessPatchPlan",
    "PaperReadinessBundle"
  ],
  sidecarArtifacts: [
    "ModelReviewBundle"
  ],
  operationalArtifacts: [
    "PluginDependencyReport"
  ],
  commandIntents: ["research:new", "research:audit", "research:review", "research:improve", "research:pack"],
  invariant: "External outputs are untrusted evidence until AutoLabOS gates classify them."
};

process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`);
