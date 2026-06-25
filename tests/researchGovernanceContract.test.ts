import { describe, expect, it } from "vitest";

import {
  RESEARCH_GOVERNANCE_ADAPTER_SURFACES,
  RESEARCH_GOVERNANCE_ARTIFACTS,
  RESEARCH_GOVERNANCE_COMMANDS,
  RESEARCH_GOVERNANCE_INVARIANTS,
  RESEARCH_GOVERNANCE_PLUGIN_NAME,
  RESEARCH_GOVERNANCE_POSITIONING
} from "../src/core/researchGovernanceContract.js";

describe("research governance contract", () => {
  it("positions AutoLabOS as a plugin-first governance harness", () => {
    expect(RESEARCH_GOVERNANCE_PLUGIN_NAME).toBe("autolabos-research-governor");
    expect(RESEARCH_GOVERNANCE_POSITIONING.primarySurface).toBe("codex_plugin");
    expect(RESEARCH_GOVERNANCE_POSITIONING.autolabosRole).toBe("governed_research_harness");
    expect(RESEARCH_GOVERNANCE_POSITIONING.standaloneWorkflowRole).toBe("reference_workflow");
    expect(RESEARCH_GOVERNANCE_POSITIONING.publicContract).toBe("artifact_gate_contract");
  });

  it("keeps the public contract centered on artifacts and gates", () => {
    expect(RESEARCH_GOVERNANCE_ARTIFACTS).toEqual([
      "ResearchBrief",
      "EvidenceBundle",
      "GateReport",
      "ReviewReport",
      "MetaHarnessPatchPlan",
      "PaperReadinessBundle"
    ]);
    expect(RESEARCH_GOVERNANCE_COMMANDS.map((command) => command.id)).toEqual([
      "research:new",
      "research:audit",
      "research:review",
      "research:improve",
      "research:pack"
    ]);
    expect(RESEARCH_GOVERNANCE_COMMANDS.every((command) => command.requiredGate.length > 0)).toBe(true);
    expect(RESEARCH_GOVERNANCE_COMMANDS.every((command) => command.disallowedShortcuts.length > 0)).toBe(true);
  });

  it("does not let adapters bypass research gates", () => {
    expect(RESEARCH_GOVERNANCE_ADAPTER_SURFACES.length).toBeGreaterThanOrEqual(5);
    expect(RESEARCH_GOVERNANCE_ADAPTER_SURFACES.every((surface) => surface.cannotBypassGates)).toBe(true);
    expect(RESEARCH_GOVERNANCE_INVARIANTS.some((item) => item.includes("untrusted evidence"))).toBe(true);
    expect(RESEARCH_GOVERNANCE_INVARIANTS.some((item) => item.includes("Review remains"))).toBe(true);
  });
});
