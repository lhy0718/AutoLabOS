import { describe, expect, it } from "vitest";

import { parseSlashCommand } from "../src/core/commands/parseSlash.js";

describe("parseSlashCommand", () => {
  it("parses command and args", () => {
    expect(parseSlashCommand("/agent run literature abc")).toEqual({
      command: "agent",
      args: ["run", "literature", "abc"]
    });
  });

  it("returns null for plain text", () => {
    expect(parseSlashCommand("hello")).toBeNull();
  });

  it("maps empty slash to /help", () => {
    expect(parseSlashCommand("/   ")).toEqual({
      command: "help",
      args: []
    });
  });

  it("accepts full-width slash prefix", () => {
    expect(parseSlashCommand("／help")).toEqual({
      command: "help",
      args: []
    });
  });

  it("parses quoted args", () => {
    expect(parseSlashCommand('/agent collect "graph neural network" --venue "Nature,Science"')).toEqual({
      command: "agent",
      args: ["collect", "graph neural network", "--venue", "Nature,Science"]
    });
  });

  it("parses escaped quotes in args", () => {
    expect(parseSlashCommand('/agent collect "title \\"quoted\\"" --dry-run')).toEqual({
      command: "agent",
      args: ["collect", 'title "quoted"', "--dry-run"]
    });
  });
});
