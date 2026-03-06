import { describe, expect, it } from "vitest";

import { buildFrame } from "../src/tui/renderFrame.js";
import { createDefaultGraphState } from "../src/core/stateGraph/defaults.js";
import { RunRecord, SuggestionItem } from "../src/types.js";
import { stripAnsi } from "../src/tui/theme.js";

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const now = new Date().toISOString();
  const graph = overrides.graph ?? createDefaultGraphState();
  const currentNode = overrides.currentNode ?? graph.currentNode;
  return {
    version: 3,
    workflowVersion: 3,
    id: overrides.id ?? "run-1",
    title: overrides.title ?? "Test run",
    topic: overrides.topic ?? "topic",
    constraints: overrides.constraints ?? [],
    objectiveMetric: overrides.objectiveMetric ?? "metric",
    status: overrides.status ?? "pending",
    currentNode,
    latestSummary: overrides.latestSummary,
    nodeThreads: overrides.nodeThreads ?? {},
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    graph,
    memoryRefs: overrides.memoryRefs ?? {
      runContextPath: ".autoresearch/runs/run-1/memory/run_context.json",
      longTermPath: ".autoresearch/runs/run-1/memory/long_term.jsonl",
      episodePath: ".autoresearch/runs/run-1/memory/episodes.jsonl"
    }
  };
}

const suggestions: SuggestionItem[] = [
  {
    key: "doctor",
    label: "/doctor",
    description: "Run environment checks",
    applyValue: "/doctor "
  },
  {
    key: "help",
    label: "/help",
    description: "Show command list",
    applyValue: "/help "
  }
];

describe("buildFrame", () => {
  it("renders compact header with version", () => {
    const frame = buildFrame({
      appVersion: "0.1.0",
      busy: false,
      thinking: false,
      thinkingFrame: 0,
      run: undefined,
      logs: [],
      input: "",
      inputCursor: 0,
      suggestions: [],
      selectedSuggestion: 0,
      colorEnabled: false
    });

    expect(stripAnsi(frame.lines[0])).toBe("AutoResearch v0.1.0");
  });

  it("places suggestions below the input line", () => {
    const frame = buildFrame({
      appVersion: "0.1.0",
      busy: false,
      thinking: false,
      thinkingFrame: 0,
      run: makeRun(),
      logs: ["ready"],
      input: "/",
      inputCursor: 1,
      suggestions,
      selectedSuggestion: 0,
      colorEnabled: false
    });

    const inputLine = frame.lines[frame.inputLineIndex - 1];
    expect(stripAnsi(inputLine)).toBe("> /");
    expect(frame.inputLineIndex).toBeLessThan(frame.lines.length);

    const suggestionRows = frame.lines.slice(frame.inputLineIndex + 1).map((line) => stripAnsi(line));
    expect(suggestionRows[0]).toBe("/doctor  Run environment checks");
    expect(suggestionRows.every((row) => !row.includes(" - "))).toBe(true);
  });

  it("computes cursor column at the end of '> input'", () => {
    const frame = buildFrame({
      appVersion: "0.1.0",
      busy: false,
      thinking: false,
      thinkingFrame: 0,
      run: undefined,
      logs: [],
      input: "abc",
      inputCursor: 3,
      suggestions: [],
      selectedSuggestion: 0,
      colorEnabled: false
    });

    expect(frame.inputColumn).toBe(6);
  });

  it("computes cursor column with wide characters", () => {
    const frame = buildFrame({
      appVersion: "0.1.0",
      busy: false,
      thinking: false,
      thinkingFrame: 0,
      run: undefined,
      logs: [],
      input: "한글",
      inputCursor: 2,
      suggestions: [],
      selectedSuggestion: 0,
      colorEnabled: false
    });

    expect(frame.inputColumn).toBe(7);
  });

  it("highlights selected suggestion with blue background", () => {
    const frame = buildFrame({
      appVersion: "0.1.0",
      busy: false,
      thinking: false,
      thinkingFrame: 0,
      run: undefined,
      logs: [],
      input: "/",
      inputCursor: 1,
      suggestions,
      selectedSuggestion: 0,
      colorEnabled: true
    });

    const selectedRow = frame.lines[frame.inputLineIndex + 1];
    expect(selectedRow).toContain("\x1b[");
    expect(selectedRow).toContain("44");
  });

  it("renders selection menu rows when active", () => {
    const frame = buildFrame({
      appVersion: "0.1.0",
      busy: true,
      thinking: false,
      thinkingFrame: 0,
      run: makeRun(),
      logs: ["ready"],
      input: "",
      inputCursor: 0,
      suggestions: [],
      selectedSuggestion: 0,
      colorEnabled: false,
      selectionMenu: {
        title: "Select model",
        options: ["gpt-5.3-codex", "gpt-5.2-codex"],
        selectedIndex: 1
      }
    });

    const plain = frame.lines.map((line) => stripAnsi(line));
    expect(plain.some((line) => line.includes("Select model"))).toBe(true);
    expect(plain.some((line) => line.trim() === "gpt-5.3-codex")).toBe(true);
    expect(plain.some((line) => line.trim() === "gpt-5.2-codex")).toBe(true);
  });

  it("highlights selected selection menu row", () => {
    const frame = buildFrame({
      appVersion: "0.1.0",
      busy: true,
      thinking: false,
      thinkingFrame: 0,
      run: makeRun(),
      logs: ["ready"],
      input: "",
      inputCursor: 0,
      suggestions: [],
      selectedSuggestion: 0,
      colorEnabled: true,
      selectionMenu: {
        title: "Select reasoning effort",
        options: ["low", "medium", "high"],
        selectedIndex: 2
      }
    });

    const selected = frame.lines.find((line) => stripAnsi(line).trim() === "high") || "";
    expect(selected).toContain("\x1b[");
    expect(selected).toContain("44");
  });

  it("renders moving monochrome gradient on Thinking text", () => {
    const a = buildFrame({
      appVersion: "0.1.0",
      busy: true,
      thinking: true,
      thinkingFrame: 1,
      run: undefined,
      logs: [],
      input: "",
      inputCursor: 0,
      suggestions: [],
      selectedSuggestion: 0,
      colorEnabled: true
    });
    const b = buildFrame({
      appVersion: "0.1.0",
      busy: true,
      thinking: true,
      thinkingFrame: 8,
      run: undefined,
      logs: [],
      input: "",
      inputCursor: 0,
      suggestions: [],
      selectedSuggestion: 0,
      colorEnabled: true
    });

    const thinkingA = a.lines.find((line) => stripAnsi(line).includes("Thinking...")) || "";
    const thinkingB = b.lines.find((line) => stripAnsi(line).includes("Thinking...")) || "";
    expect(thinkingA).toContain("\x1b[");
    expect(thinkingA).not.toBe(thinkingB);
  });
});
