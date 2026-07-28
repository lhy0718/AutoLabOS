import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const VALIDATOR = path.join(
  ROOT,
  "studies",
  "grader-conform",
  "scripts",
  "validate-v2-preflight.mjs"
);
const PROTOCOL = path.join(
  ROOT,
  "studies",
  "grader-conform",
  "v2",
  "method",
  "preflight-contract.v2.json"
);

function run(protocolPath: string) {
  return spawnSync(process.execPath, [
    VALIDATOR,
    "--protocol", protocolPath,
    "--repo-root", ROOT,
  ], { cwd: ROOT, encoding: "utf8" });
}

function mutateProtocol(
  mutate: (protocol: Record<string, any>) => void
): { root: string; protocolPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grader-conform-v2-protocol-"));
  const protocol = JSON.parse(fs.readFileSync(PROTOCOL, "utf8"));
  mutate(protocol);
  const protocolPath = path.join(root, "protocol.json");
  fs.writeFileSync(protocolPath, `${JSON.stringify(protocol, null, 2)}\n`, "utf8");
  return { root, protocolPath };
}

describe("grader-conform v2 structural preflight contract", () => {
  it("validates the bound frame while keeping execution fail-closed", () => {
    const output = execFileSync(process.execPath, [
      VALIDATOR,
      "--protocol", PROTOCOL,
      "--repo-root", ROOT,
    ], { cwd: ROOT, encoding: "utf8" });
    const report = JSON.parse(output);

    expect(report).toMatchObject({
      valid: true,
      status: "preflight_open_not_frozen",
      execution_authorized: false,
      all_preflight_gates_pass: false,
      passing_gate_count: 4,
      blocked_gate_count: 6,
      bound_artifact_count: 7,
    });
  });

  it.each([
    [
      (protocol: Record<string, any>) => {
        protocol.execution_authorized = true;
      },
      "execution cannot be authorized while a preflight gate is blocked",
    ],
    [
      (protocol: Record<string, any>) => {
        protocol.frame_contract.retained_candidate_count = 109;
      },
      "retained candidate count must equal 178",
    ],
    [
      (protocol: Record<string, any>) => {
        protocol.control_sampling.classes[0].minimum_repositories = 2;
      },
      "normal_behavior minimum repositories must be at least 6",
    ],
    [
      (protocol: Record<string, any>) => {
        protocol.arm_contract.baseline_arms.pop();
      },
      "baseline arms must match the frozen set",
    ],
    [
      (protocol: Record<string, any>) => {
        protocol.arm_contract.primary_comparator_arm = "freeform_contract_property";
      },
      "prior-work comparator or semantic arm distinction mismatch",
    ],
    [
      (protocol: Record<string, any>) => {
        protocol.analysis_plan.primary_comparator = "freeform_contract_property";
      },
      "analysis contract mismatch",
    ],
    [
      (protocol: Record<string, any>) => {
        protocol.verified_bindings[1].sha256 = "f".repeat(64);
      },
      "v2_frame_bundle_manifest binding hash mismatch",
    ],
    [
      (protocol: Record<string, any>) => {
        protocol.all_preflight_gates_pass = true;
      },
      "all_preflight_gates_pass does not match gate states",
    ],
  ])("rejects protocol weakening or binding attack %#", (mutate, message) => {
    const fixture = mutateProtocol(mutate);
    try {
      const result = run(fixture.protocolPath);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(message);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
