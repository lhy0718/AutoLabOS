import { describe, expect, it } from "vitest";

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

describe("plugin operations preflight contract", () => {
  it("keeps CI and workstation gates explicit and forbids partial promotion", () => {
    const source = fs.readFileSync(
      path.join(ROOT, "scripts", "validate-plugin-operations.mjs"),
      "utf8"
    );

    for (const gate of [
      "direct_research_acceptance",
      "repo_bridge_acceptance",
      "hermetic_cache_acceptance",
      "fault_injection_matrix",
      "installed_bridge_acceptance",
      "installed_plugin_discovery"
    ]) {
      expect(source).toContain(gate);
    }
    expect(source).toContain("partialSuccessPromoted: false");
    expect(source).toContain("failedGateCount");
    expect(source).toContain("reportPersisted");
    expect(source).toContain("AUTOLABOS_OPERATIONS_FAIL_GATE");
    expect(source).toContain("injected_failure");
    expect(source).not.toMatch(/(?:\/home\/|\/Users\/|[A-Za-z]:\\\\)/u);
  });
});
