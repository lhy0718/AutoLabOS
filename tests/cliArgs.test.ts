import { describe, expect, it } from "vitest";

import { resolveCliAction } from "../src/cli/args.js";

describe("resolveCliAction", () => {
  it("runs app when no args", () => {
    expect(resolveCliAction([])).toEqual({ kind: "run" });
  });

  it("supports --help", () => {
    expect(resolveCliAction(["--help"]).kind).toBe("help");
  });

  it("supports web mode with host and port", () => {
    expect(resolveCliAction(["web", "--host", "0.0.0.0", "--port", "3001"])).toEqual({
      kind: "web",
      host: "0.0.0.0",
      port: 3001
    });
  });

  it("supports compare-analysis mode", () => {
    expect(resolveCliAction(["compare-analysis", "--run", "run-123", "--limit", "5", "--no-judge"])).toEqual({
      kind: "compare-analysis",
      runId: "run-123",
      limit: 5,
      judge: false
    });
  });

  it("requires a run id for compare-analysis", () => {
    const action = resolveCliAction(["compare-analysis"]);
    expect(action.kind).toBe("error");
  });

  it("rejects init subcommand", () => {
    const action = resolveCliAction(["init"]);
    expect(action.kind).toBe("error");
  });
});
