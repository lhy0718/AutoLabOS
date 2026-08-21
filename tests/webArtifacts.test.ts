import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { ensureScaffold, resolveAppPaths } from "../src/config.js";
import { listRunArtifacts, readRunArtifact, resolveRunArtifactPath } from "../src/web/artifacts.js";

describe("web artifacts", () => {
  it("lists nested artifacts and blocks path traversal", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-artifacts-"));
    const paths = resolveAppPaths(cwd);
    await ensureScaffold(paths);
    const runId = "run-1";
    const runDir = path.join(paths.runsDir, runId, "paper");
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(paths.runsDir, runId, "metrics.json"), '{"score":1}\n', "utf8");
    await fs.writeFile(path.join(runDir, "main.tex"), "\\section{Test}\n", "utf8");

    const artifacts = await listRunArtifacts(paths, runId);
    expect(artifacts.map((item) => item.path)).toEqual(
      expect.arrayContaining(["metrics.json", "paper", "paper/main.tex"])
    );

    await expect(() => resolveRunArtifactPath(paths, runId, "../config.yaml")).toThrow();
    const artifact = await readRunArtifact(paths, runId, "metrics.json");
    expect(artifact.contentType).toContain("application/json");
    expect(artifact.data.toString("utf8")).toContain('"score":1');
  });

  it("ignores atomic-write temp files and entries removed after readdir", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-artifact-race-"));
    const paths = resolveAppPaths(cwd);
    await ensureScaffold(paths);
    const runId = "run-race";
    const runDir = path.join(paths.runsDir, runId);
    const stablePath = path.join(runDir, "stable.json");
    const transientPath = path.join(runDir, ".run_record.json.123.456.abcdef.tmp");
    const vanishingPath = path.join(runDir, "vanishing.json");
    await fs.mkdir(runDir, { recursive: true });
    await Promise.all([
      fs.writeFile(stablePath, '{"stable":true}\n', "utf8"),
      fs.writeFile(transientPath, '{"pending":true}\n', "utf8"),
      fs.writeFile(vanishingPath, '{"vanishing":true}\n', "utf8")
    ]);
    const realStat = fs.stat.bind(fs);
    vi.spyOn(fs, "stat").mockImplementation(async (target) => {
      if (String(target) === vanishingPath) {
        await fs.unlink(vanishingPath);
      }
      return realStat(target);
    });

    const artifacts = await listRunArtifacts(paths, runId);

    expect(artifacts.map((item) => item.path)).toEqual(["stable.json"]);
  });

  it("rejects run-id traversal and symbolic-link escapes", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-artifact-symlink-"));
    const paths = resolveAppPaths(cwd);
    await ensureScaffold(paths);
    const runId = "run-symlink";
    const runDir = path.join(paths.runsDir, runId);
    const outsidePath = path.join(cwd, "outside.json");
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(outsidePath, '{"private":true}\n', "utf8");
    await fs.symlink(outsidePath, path.join(runDir, "escape.json"));

    expect(() => resolveRunArtifactPath(paths, "../outside", "file.json")).toThrow("Invalid run id");
    await expect(readRunArtifact(paths, runId, "escape.json")).rejects.toThrow("symbolic link");
    expect((await listRunArtifacts(paths, runId)).map((item) => item.path)).not.toContain("escape.json");
  });
});
