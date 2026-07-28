import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const RUNNER = path.join(ROOT, "studies", "grader-conform", "scripts", "run-probes.mjs");
const PYTHON = process.env.PYTHON
  ? path.resolve(process.env.PYTHON)
  : execFileSync("which", ["python3"], { encoding: "utf8" }).trim();

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function createFixture(): {
  root: string;
  args: string[];
  manifestPath: string;
  outputPath: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "conformance-runner-"));
  const cacheRoot = path.join(root, "cache");
  const repository = path.join(cacheRoot, "fixture-repository");
  const adapterRoot = path.join(root, "adapters");
  fs.mkdirSync(repository, { recursive: true });
  fs.mkdirSync(adapterRoot);

  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.email", "fixture@example.invalid"]);
  git(repository, ["config", "user.name", "Fixture Author"]);
  fs.writeFileSync(path.join(repository, "state.json"), '{"relation_holds":false}\n', "utf8");
  git(repository, ["add", "state.json"]);
  git(repository, ["commit", "--quiet", "-m", "parent"]);
  const parentCommit = git(repository, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(repository, "state.json"), '{"relation_holds":true}\n', "utf8");
  git(repository, ["commit", "--quiet", "-am", "fix"]);
  const fixCommit = git(repository, ["rev-parse", "HEAD"]);

  fs.writeFileSync(
    path.join(adapterRoot, "adapter.py"),
    [
      "import argparse, json",
      "from pathlib import Path",
      "parser = argparse.ArgumentParser()",
      "parser.add_argument('--revision-root', required=True)",
      "args = parser.parse_args()",
      "state = json.loads((Path(args.revision_root) / 'state.json').read_text())",
      "print(json.dumps({'schema_version': '1.0', 'relation_holds': state['relation_holds'], 'observations': {'fixture': True}}))",
      "",
    ].join("\n"),
    "utf8",
  );

  const registryPath = path.join(root, "registry.json");
  const adjudicationPath = path.join(root, "adjudication.json");
  const manifestPath = path.join(root, "manifest.json");
  const outputPath = path.join(root, "results", "receipt.json");
  writeJson(registryPath, {
    schema_version: "1.0",
    sources: { source_fixture: { cache_key: "fixture-repository" } },
    lineages: [{
      id: "lineage_fixture",
      source_id: "source_fixture",
      parent_commit: parentCommit,
      fix_commit: fixCommit,
      fault_family: "representation_invariance",
    }],
  });
  writeJson(adjudicationPath, {
    schema_version: "1.0",
    decisions: [{ id: "lineage_fixture", decision: "admit" }],
  });
  writeJson(manifestPath, {
    schema_version: "1.0",
    development_after_initial_outcomes: false,
    probes: [{
      lineage_id: "lineage_fixture",
      relation_family: "representation_invariance",
      adapter: "adapter.py",
      contract_source: "Independent fixture contract.",
      transformation_target: "graded artifact",
    }],
  });

  return {
    root,
    manifestPath,
    outputPath,
    args: [
      RUNNER,
      "--registry", registryPath,
      "--adjudication", adjudicationPath,
      "--manifest", manifestPath,
      "--repo-root", cacheRoot,
      "--worktree-root", path.join(root, "worktrees"),
      "--adapter-root", adapterRoot,
      "--python", PYTHON,
      "--output", outputPath,
    ],
  };
}

describe("study probe runner", () => {
  it("replays a real parent/fix Git pair and emits a deterministic outcome signature", () => {
    const fixture = createFixture();
    try {
      execFileSync(process.execPath, fixture.args, { cwd: ROOT, encoding: "utf8" });
      const receipt = JSON.parse(fs.readFileSync(fixture.outputPath, "utf8"));

      expect(receipt).toMatchObject({
        schema_version: "1.0",
        probe_count: 1,
        source_count: 1,
        detected_count: 1,
        fixed_revision_false_alarm_count: 0,
        behavioral_outcomes_included: true,
        paper_scale_claim_authorized: false,
      });
      expect(receipt.outcome_signature_sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(receipt.results[0].parent.receipt.relation_holds).toBe(false);
      expect(receipt.results[0].fixed.receipt.relation_holds).toBe(true);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an adapter path that escapes the declared adapter root", () => {
    const fixture = createFixture();
    try {
      const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, "utf8"));
      manifest.probes[0].adapter = "../outside.py";
      writeJson(fixture.manifestPath, manifest);

      const result = spawnSync(process.execPath, fixture.args, { cwd: ROOT, encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Adapter path escapes adapter root");
      expect(fs.existsSync(fixture.outputPath)).toBe(false);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
