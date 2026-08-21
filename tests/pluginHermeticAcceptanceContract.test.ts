import { describe, expect, it } from "vitest";

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

describe("plugin hermetic cache acceptance contract", () => {
  it("requires isolated sync, strict doctor, bridge hash, dependency, and shared acceptance", () => {
    const source = fs.readFileSync(
      path.join(ROOT, "scripts", "validate-plugin-hermetic-cache.mjs"),
      "utf8"
    );
    for (const contract of [
      "hermetic_cache_sync_passes",
      "hermetic_strict_doctor_passes",
      "hermetic_cached_bridge_exists",
      "hermetic_cached_bridge_matches_repo",
      "hermetic_bridge_dependency_passes",
      "runResearchGovernanceAcceptance",
      "temporary_isolated_codex_home"
    ]) {
      expect(source).toContain(contract);
    }
    expect(source).not.toMatch(/(?:\/home\/|\/Users\/|[A-Za-z]:\\\\)/u);
  });
});
