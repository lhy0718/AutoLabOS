import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { importGovernanceSeedBundle } from "../src/core/benchmark/governanceSeedBundle.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("governanceSeedBundle", () => {
  it("imports an external seed directory into a workspace-controlled output bundle", async () => {
    const workspace = await makeTempDir("autolabos-seed-workspace-");
    const source = await makeTempDir("autolabos-seed-source-");
    await writeFile(path.join(source, "case-alpha-brief.md"), "# Research Brief\n", "utf8");
    await mkdir(path.join(source, "fixtures"), { recursive: true });
    await writeFile(path.join(source, "fixtures", "result.json"), "{\"ok\":true}\n", "utf8");

    const result = await importGovernanceSeedBundle({
      cwd: workspace,
      sourcePath: source,
      taskId: "case-alpha"
    });

    expect(result.manifest.task_id).toBe("case-alpha");
    expect(result.manifest.mode).toBe("import");
    expect(result.manifest.source_path).toBe(source);
    expect(result.manifest.source_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.manifest.files.map((file) => file.relative_path)).toEqual([
      "case-alpha-brief.md",
      "fixtures/result.json"
    ]);
    expect(result.manifest.output_dir).toBe("outputs/governance-benchmark/seeds/case-alpha");
    expect(await readFile(path.join(workspace, result.manifest.output_dir, "source", "case-alpha-brief.md"), "utf8"))
      .toBe("# Research Brief\n");
    expect(JSON.parse(await readFile(result.manifestPath, "utf8"))).toMatchObject({
      task_id: "case-alpha",
      mode: "import"
    });
  });

  it("writes a reference-only manifest without copying the source bundle", async () => {
    const workspace = await makeTempDir("autolabos-seed-reference-workspace-");
    const source = await makeTempDir("autolabos-seed-reference-source-");
    await writeFile(path.join(source, "case-beta-brief.md"), "# Research Brief\n", "utf8");

    const result = await importGovernanceSeedBundle({
      cwd: workspace,
      sourcePath: source,
      taskId: "case-beta",
      referenceOnly: true
    });

    expect(result.manifest.mode).toBe("reference");
    await expect(stat(path.join(workspace, result.manifest.output_dir, "source"))).rejects.toThrow();
    expect(JSON.parse(await readFile(result.manifestPath, "utf8"))).toMatchObject({
      task_id: "case-beta",
      mode: "reference",
      source_path: source
    });
  });

  it("rejects output directories outside the workspace", async () => {
    const workspace = await makeTempDir("autolabos-seed-outdir-workspace-");
    const source = await makeTempDir("autolabos-seed-outdir-source-");
    const outside = await makeTempDir("autolabos-seed-outdir-outside-");
    await writeFile(path.join(source, "brief.md"), "# Research Brief\n", "utf8");

    await expect(
      importGovernanceSeedBundle({
        cwd: workspace,
        sourcePath: source,
        taskId: "case-gamma",
        outDir: outside
      })
    ).rejects.toThrow("output directory must stay inside the workspace");
  });
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
