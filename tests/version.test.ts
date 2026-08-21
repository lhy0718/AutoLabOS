import path from "node:path";
import { describe, expect, it } from "vitest";

import { clearVersionCache, getAppVersion } from "../src/tui/version.js";

describe("getAppVersion", () => {
  it("reads semver from package.json", () => {
    clearVersionCache();
    const version = getAppVersion({ useCache: false });
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("returns fallback when package file is missing", () => {
    clearVersionCache();
    const missingPath = path.join(process.cwd(), ".missing-package-json");
    const version = getAppVersion({
      packageJsonPath: missingPath,
      useCache: false,
      fallback: "0.0.0"
    });
    expect(version).toBe("0.0.0");
  });
});
