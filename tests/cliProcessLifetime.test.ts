import { afterEach, describe, expect, it, vi } from "vitest";

import { runWithProcessLifetime } from "../src/cli/processLifetime.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("CLI process lifetime", () => {
  it("holds a referenced timer until asynchronous work resolves", async () => {
    vi.useFakeTimers();
    let resolveWork: ((value: string) => void) | undefined;
    const result = runWithProcessLifetime(
      () => new Promise<string>((resolve) => {
        resolveWork = resolve;
      })
    );

    expect(vi.getTimerCount()).toBe(1);
    resolveWork?.("complete");
    await expect(result).resolves.toBe("complete");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases the timer when asynchronous work rejects", async () => {
    vi.useFakeTimers();
    const result = runWithProcessLifetime(async () => {
      throw new Error("fixture failure");
    });

    await expect(result).rejects.toThrow("fixture failure");
    expect(vi.getTimerCount()).toBe(0);
  });
});
