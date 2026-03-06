import { describe, expect, it } from "vitest";

import { TitleGenerator } from "../src/core/runs/titleGenerator.js";

class MockCodexSuccess {
  async runForText(): Promise<string> {
    return "  Multi Agent Planning for Retrieval-Augmented Research Workflows  ";
  }
}

class MockCodexFail {
  async runForText(): Promise<string> {
    throw new Error("codex unavailable");
  }
}

describe("TitleGenerator", () => {
  it("sanitizes codex title output", async () => {
    const generator = new TitleGenerator(new MockCodexSuccess() as never);
    const title = await generator.generateTitle("topic", ["a"], "metric");
    expect(title).toBe("Multi Agent Planning for Retrieval-Augmented Research Workflows");
  });

  it("falls back to topic when codex fails", async () => {
    const generator = new TitleGenerator(new MockCodexFail() as never);
    const title = await generator.generateTitle("My Topic", [], "");
    expect(title).toBe("My Topic");
  });
});
