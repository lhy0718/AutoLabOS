import { afterEach, describe, expect, it } from "vitest";

import {
  CodexCliClient,
  normalizeCodexWorkspacePath,
  presentCodexPath
} from "../src/integrations/codex/codexCliClient.js";

describe("CodexCliClient fake response sequence", () => {
  afterEach(() => {
    delete process.env.AUTOLABOS_FAKE_CODEX_RESPONSE;
    delete process.env.AUTOLABOS_FAKE_CODEX_RESPONSE_SEQUENCE;
  });

  it("consumes fake response sequence entries in order", async () => {
    process.env.AUTOLABOS_FAKE_CODEX_RESPONSE_SEQUENCE = JSON.stringify([
      { reply_lines: ["first"] },
      { reply_lines: ["second"] }
    ]);

    const client = new CodexCliClient(process.cwd());
    const first = await client.runForText({
      prompt: "one",
      sandboxMode: "read-only",
      approvalPolicy: "never"
    });
    const second = await client.runForText({
      prompt: "two",
      sandboxMode: "read-only",
      approvalPolicy: "never"
    });

    expect(first).toContain("first");
    expect(second).toContain("second");
  });

  it("maps /private sandbox aliases to writable workspace paths", () => {
    expect(presentCodexPath("/private/tmp/demo")).toBe("/tmp/demo");
    expect(
      normalizeCodexWorkspacePath("/tmp/demo/outputs/experiment.py", "/private/tmp/demo")
    ).toBe("/private/tmp/demo/outputs/experiment.py");
    expect(
      normalizeCodexWorkspacePath("/var/folders/x/demo/run.py", "/private/var/folders/x/demo")
    ).toBe("/private/var/folders/x/demo/run.py");
  });
});
