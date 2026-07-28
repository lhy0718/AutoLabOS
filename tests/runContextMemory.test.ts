import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { RunContextMemory } from "../src/core/memory/runContextMemory.js";

describe("RunContextMemory", () => {
  it("preserves concurrent mutations made through separate instances", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-context-"));
    const filePath = path.join(root, "run_context.json");
    const instances = Array.from(
      { length: 50 },
      () => new RunContextMemory(filePath)
    );

    await Promise.all(
      instances.map((memory, index) =>
        memory.put(`key_${index}`, { index })
      )
    );

    const entries = await new RunContextMemory(filePath).entries();
    expect(entries).toHaveLength(50);
    expect(
      entries.map((entry) => entry.key).sort()
    ).toEqual(
      Array.from({ length: 50 }, (_, index) => `key_${index}`).sort()
    );
  });

  it("waits for an in-flight mutation before reading", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "autolabos-run-context-read-"));
    const filePath = path.join(root, "run_context.json");
    const writer = new RunContextMemory(filePath);
    const reader = new RunContextMemory(filePath);

    const write = writer.put("handoff", { ready: true });
    const value = await reader.get<{ ready: boolean }>("handoff");
    await write;

    expect(value).toEqual({ ready: true });
  });
});
