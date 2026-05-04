import { describe, expect, it } from "vitest";

import { collectNonBlockingEnvironmentSnapshot } from "../src/core/runtime/environmentSnapshot.js";

describe("runtime environment snapshot surface", () => {
  it("returns a snapshot when collection succeeds", async () => {
    const result = await collectNonBlockingEnvironmentSnapshot(async () => ({
      python_version: "Python 3.11.9",
      node_version: "v22.0.0",
      installed_packages: ["numpy==2.1.0"],
      gpu_available: false,
      available_disk_mb: 1024,
      working_directory: "<workspace>"
    }));

    expect(result).toEqual({
      status: "available",
      snapshot: {
        python_version: "Python 3.11.9",
        node_version: "v22.0.0",
        installed_packages: ["numpy==2.1.0"],
        gpu_available: false,
        available_disk_mb: 1024,
        working_directory: "<workspace>"
      }
    });
  });

  it("downgrades collection errors to an unavailable surface", async () => {
    const result = await collectNonBlockingEnvironmentSnapshot(async () => {
      throw new Error("df timed out");
    });

    expect(result).toEqual({
      status: "unavailable",
      error: "df timed out"
    });
  });
});
