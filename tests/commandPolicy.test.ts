import { describe, expect, it } from "vitest";

import { LocalAciAdapter } from "../src/tools/aciLocalAdapter.js";
import { evaluateCommandPolicy } from "../src/tools/commandPolicy.js";

describe("command policy", () => {
  it("allows normal local verification commands", () => {
    const decision = evaluateCommandPolicy("python3 -m py_compile script.py", {
      scope: "tests",
      allowNetwork: false
    });

    expect(decision.allowed).toBe(true);
    expect(decision.rule_id).toBeUndefined();
  });

  it("blocks destructive commands before execution", async () => {
    const aci = new LocalAciAdapter();
    const obs = await aci.runCommand("rm -rf ./tmp-artifacts");

    expect(obs.status).toBe("error");
    expect(obs.exit_code).toBe(126);
    expect(obs.policy).toMatchObject({
      allowed: false,
      scope: "command",
      rule_id: "destructive_rm_rf"
    });
    expect(obs.stderr).toContain("Policy blocked command");
  });

  it("blocks network install commands unless network access is explicitly allowed", () => {
    const blocked = evaluateCommandPolicy("pip install requests", {
      scope: "command",
      allowNetwork: false
    });
    const allowed = evaluateCommandPolicy("pip install requests", {
      scope: "command",
      allowNetwork: true
    });

    expect(blocked).toMatchObject({
      allowed: false,
      rule_id: "network_fetch_disabled"
    });
    expect(allowed.allowed).toBe(true);
  });
});
