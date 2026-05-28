import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";

import { describe, expect, it } from "vitest";

import { PersistedEventStream, readPersistedRunEvents } from "../src/core/events.js";
import { RunIndexDatabase } from "../src/core/runs/runIndexDatabase.js";

describe("persisted event stream", () => {
  it("writes per-run event logs and replays recent events", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-events-"));
    const runsDir = path.join(root, ".autolabos", "runs");
    const stream = new PersistedEventStream(runsDir);

    const first = stream.emit({
      type: "OBS_RECEIVED",
      runId: "run-1",
      node: "collect_papers",
      payload: { text: "first" }
    });
    stream.emit({
      type: "OBS_RECEIVED",
      runId: "run-2",
      node: "collect_papers",
      payload: { text: "other" }
    });
    const second = stream.emit({
      type: "OBS_RECEIVED",
      runId: "run-1",
      node: "collect_papers",
      payload: { text: "second" }
    });

    const raw = await fs.readFile(path.join(runsDir, "run-1", "events.jsonl"), "utf8");
    expect(raw).toContain('"runId":"run-1"');
    expect(raw).toContain('"text":"first"');
    expect(raw).toContain('"text":"second"');

    expect(stream.history(10, "run-1").map((event) => event.id)).toEqual([first.id, second.id]);
    expect(readPersistedRunEvents({ runsDir, runId: "run-1", limit: 10 }).map((event) => event.id)).toEqual([
      first.id,
      second.id
    ]);
    expect(readPersistedRunEvents({ runsDir, runId: "run-2", limit: 10 })).toHaveLength(1);

    const index = new RunIndexDatabase(path.join(runsDir, "runs.sqlite"));
    try {
      const indexed = index.listRunEvents("run-1", 10);
      expect(indexed.map((event) => event.eventId)).toEqual([first.id, second.id]);
      expect(indexed.map((event) => event.eventSeq)).toEqual([1, 2]);
    } finally {
      index.close();
    }
  });

  it("quarantines malformed event log lines before appending new events", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-events-repair-"));
    const runsDir = path.join(root, ".autolabos", "runs");
    const runDir = path.join(runsDir, "run-1");
    await fs.mkdir(runDir, { recursive: true });
    const validBefore = {
      type: "NODE_STARTED",
      runId: "run-1",
      payload: {},
      id: "evt_before",
      timestamp: "2026-01-01T00:00:00.000Z"
    };
    const validAfter = {
      type: "NODE_COMPLETED",
      runId: "run-1",
      payload: {},
      id: "evt_after",
      timestamp: "2026-01-01T00:00:01.000Z"
    };
    await fs.writeFile(
      path.join(runDir, "events.jsonl"),
      [
        JSON.stringify(validBefore),
        '{"type":"OBS_RECEIVED","runId":"run-1","payload":{"text":"partial"}',
        JSON.stringify(validAfter)
      ].join("\n") + "\n",
      "utf8"
    );

    const stream = new PersistedEventStream(runsDir);
    const appended = stream.emit({
      type: "OBS_RECEIVED",
      runId: "run-1",
      node: "collect_papers",
      payload: { text: "after repair" }
    });

    const raw = await fs.readFile(path.join(runDir, "events.jsonl"), "utf8");
    const parsed = raw.trim().split("\n").map((line) => JSON.parse(line));
    expect(parsed.map((event) => event.id)).toEqual(["evt_before", "evt_after", appended.id]);
    expect((await fs.readdir(runDir)).some((name) => name.includes(".malformed-"))).toBe(true);
  });

});
