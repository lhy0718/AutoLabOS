import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MINIMUM_PAPER_SCALE_CONFIRMATORY_SOURCE_BUNDLES,
  MINIMUM_PROVISIONAL_CONFIRMATORY_SOURCE_BUNDLES
} from "../src/core/benchmark/promotionBenchmarkConfirmatoryIntake.js";
import {
  MINIMUM_PROMOTION_PAPER_ELIGIBLE_CASES
} from "../src/core/benchmark/promotionBenchmarkConfirmatoryContract.js";

describe("promotion benchmark documentation contract", () => {
  it("distinguishes provisional intake from paper-scale eligibility", async () => {
    const readme = await readFile(
      path.join(process.cwd(), "benchmarks", "promotion-governance", "README.md"),
      "utf8"
    );

    expect(readme).toContain(
      `at least ${MINIMUM_PROVISIONAL_CONFIRMATORY_SOURCE_BUNDLES} entries for provisional intake`
    );
    expect(readme).toContain(
      `${MINIMUM_PAPER_SCALE_CONFIRMATORY_SOURCE_BUNDLES} entries for paper-scale intake`
    );
    expect(readme).toContain(
      `at least ${MINIMUM_PAPER_SCALE_CONFIRMATORY_SOURCE_BUNDLES} source-hash-distinct base bundles are present`
    );
    expect(readme).toContain(
      `at least ${MINIMUM_PROMOTION_PAPER_ELIGIBLE_CASES} cases are present`
    );
    expect(readme).not.toContain(
      `at least ${MINIMUM_PROVISIONAL_CONFIRMATORY_SOURCE_BUNDLES} source-hash-distinct base bundles are present`
    );
  });
});
