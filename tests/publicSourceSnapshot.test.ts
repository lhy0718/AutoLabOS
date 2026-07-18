import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { exportPublicSourceSnapshot } from "../scripts/lib/public-source-snapshot.mjs";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("public source snapshot", () => {
  it("exports a deterministic clean revision without Git history", async () => {
    const fixture = await createRepositoryFixture();
    const firstOut = path.join(fixture.root, "snapshot-a");
    const secondOut = path.join(fixture.root, "snapshot-b");

    const first = await exportPublicSourceSnapshot({ cwd: fixture.repo, outDir: firstOut });
    const second = await exportPublicSourceSnapshot({ cwd: fixture.repo, outDir: secondOut });

    expect(await readFile(path.join(firstOut, "README.md"), "utf8")).toBe("# Fixture\n");
    await expect(readFile(path.join(firstOut, ".git", "HEAD"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(first.history_included).toBe(false);
    expect(first.source.revision).toBe(runGit(fixture.repo, ["rev-parse", "HEAD"]).trim());
    expect(first.file_count).toBe(2);
    expect(first.tree_sha256).toBe(second.tree_sha256);
    const firstManifest = await readFile(path.join(firstOut, "public-source-snapshot.json"), "utf8");
    const secondManifest = await readFile(path.join(secondOut, "public-source-snapshot.json"), "utf8");
    expect(firstManifest).toBe(secondManifest);
  });

  it("rejects a dirty working tree and an existing output directory", async () => {
    const fixture = await createRepositoryFixture();
    await writeFile(path.join(fixture.repo, "untracked.txt"), "draft\n", "utf8");
    await expect(exportPublicSourceSnapshot({
      cwd: fixture.repo,
      outDir: path.join(fixture.root, "dirty-output")
    })).rejects.toThrow("working tree must be clean");

    await rm(path.join(fixture.repo, "untracked.txt"));
    const existingOut = path.join(fixture.root, "existing-output");
    await mkdir(existingOut);
    await expect(exportPublicSourceSnapshot({ cwd: fixture.repo, outDir: existingOut }))
      .rejects.toThrow("must name a new directory");
  });

  it("rejects output paths inside the source repository without creating parents", async () => {
    const fixture = await createRepositoryFixture();
    const insideOut = path.join(fixture.repo, "generated", "snapshot");

    await expect(exportPublicSourceSnapshot({ cwd: fixture.repo, outDir: insideOut }))
      .rejects.toThrow("must be outside the source repository");
    await expect(readFile(path.join(fixture.repo, "generated", "marker.txt"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects personal home paths without retaining a partial snapshot", async () => {
    const fixture = await createRepositoryFixture({
      extraFile: {
        path: "notes.txt",
        content: `source=${path.join(os.homedir(), "private", "notes.md")}\n`
      }
    });
    const outDir = path.join(fixture.root, "rejected-output");

    await expect(exportPublicSourceSnapshot({ cwd: fixture.repo, outDir }))
      .rejects.toThrow("personal_home_path");
    await expect(readFile(path.join(outDir, "notes.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects non-placeholder credential assignments", async () => {
    const assignment = ["SERVICE_ACCESS", "TOKEN=production-value"].join("_");
    const fixture = await createRepositoryFixture({
      extraFile: { path: "runtime.env", content: `${assignment}\n` }
    });

    await expect(exportPublicSourceSnapshot({
      cwd: fixture.repo,
      outDir: path.join(fixture.root, "credential-output")
    })).rejects.toThrow("credential_assignment");
  });

  it("allows environment-variable wiring and explicit test credentials", async () => {
    const variableName = ["SERVICE_ACCESS", "TOKEN"].join("_");
    const fixture = await createRepositoryFixture({
      extraFile: {
        path: "src/config.js",
        content: `const ORIGINAL_${variableName} = process.env.${variableName};\nconst fixture = '${variableName}="test-service-value"';\n`
      }
    });

    await expect(exportPublicSourceSnapshot({
      cwd: fixture.repo,
      outDir: path.join(fixture.root, "fixture-output")
    })).resolves.toMatchObject({ scan: { portable: true, findings: 0 } });
  });

  it("rejects symlinks that escape the exported tree", async () => {
    const fixture = await createRepositoryFixture();
    await symlink("../outside.txt", path.join(fixture.repo, "outside-link"));
    runGit(fixture.repo, ["add", "outside-link"]);
    runGit(fixture.repo, ["commit", "-q", "-m", "add link"]);

    await expect(exportPublicSourceSnapshot({
      cwd: fixture.repo,
      outDir: path.join(fixture.root, "symlink-output")
    })).rejects.toThrow("unsafe_symlink");
  });
});

async function createRepositoryFixture(options: {
  extraFile?: { path: string; content: string };
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "public-source-snapshot-"));
  tempRoots.push(root);
  const repo = path.join(root, "source");
  await mkdir(path.join(repo, "src"), { recursive: true });
  await writeFile(path.join(repo, "README.md"), "# Fixture\n", "utf8");
  await writeFile(path.join(repo, "src", "main.js"), "export const ready = true;\n", "utf8");
  if (options.extraFile) {
    const target = path.join(repo, options.extraFile.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, options.extraFile.content, "utf8");
  }
  runGit(repo, ["init", "-q"]);
  runGit(repo, ["config", "user.name", "Fixture Author"]);
  runGit(repo, ["config", "user.email", "fixture@example.invalid"]);
  runGit(repo, ["add", "."]);
  runGit(repo, ["commit", "-q", "-m", "initial"]);
  return { root, repo };
}

function runGit(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return result.stdout;
}
