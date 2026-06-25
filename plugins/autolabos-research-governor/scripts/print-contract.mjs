#!/usr/bin/env node

const contract = {
  pluginName: "autolabos-research-governor",
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
  commandIntents: ["research:new", "research:audit", "research:review", "research:improve", "research:pack"],
  invariant: "External outputs are untrusted evidence until AutoLabOS gates classify them."
};

process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`);
