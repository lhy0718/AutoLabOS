import { describe, expect, it } from "vitest";

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

describe("plugin fault matrix contract", () => {
  it("defines every production-pilot fault class and repair target", () => {
    const source = fs.readFileSync(path.join(ROOT, "scripts", "validate-plugin-fault-matrix.mjs"), "utf8");
    const cases = [
      "missing_cli",
      "cli_contract_mismatch",
      "missing_cache",
      "stale_cache_version",
      "bridge_drift",
      "schema_mismatch",
      "non_portable_bundle_content"
    ];

    for (const fault of cases) expect(source).toContain(`"${fault}"`);
    expect(source).toContain("plugin_fault_injection_matrix");
    expect(source).toContain("repairTarget");
    expect(source).toContain("writeValidationReport");
    expect(source).not.toMatch(/(?:\/home\/|\/Users\/|[A-Za-z]:\\\\)/u);
  });
});
