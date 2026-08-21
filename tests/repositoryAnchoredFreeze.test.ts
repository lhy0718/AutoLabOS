import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { auditRepositoryAnchoredFreeze } from "../scripts/verify-repository-anchored-freeze.mjs";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("repository-anchored execution freeze", () => {
  it("binds tracked inputs to a commit while allowing explicitly hash-bound generated files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-anchor-test-"));
    try {
      await fs.mkdir(path.join(root, "method"), { recursive: true });
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.mkdir(path.join(root, "dist"), { recursive: true });
      const source = "export const value = 1;\n";
      const generated = "export const value = 1;\n";
      await fs.writeFile(path.join(root, "src", "input.ts"), source);
      await fs.writeFile(path.join(root, "dist", "input.js"), generated);
      const freezePath = path.join(root, "method", "freeze.json");
      await fs.writeFile(freezePath, `${JSON.stringify({
        schema_version: "1.0",
        artifact_type: "execution_freeze_receipt",
        repository_anchor: {
          required: true,
          tracked_commit_required: true,
          generated_files: ["../dist/input.js"]
        },
        files: {
          "../src/input.ts": sha256(source),
          "../dist/input.js": sha256(generated)
        }
      }, null, 2)}\n`);
      git(root, ["init", "-b", "main"]);
      git(root, ["config", "user.email", "fixture@example.invalid"]);
      git(root, ["config", "user.name", "Fixture"]);
      git(root, ["add", "method/freeze.json", "src/input.ts"]);
      git(root, ["commit", "-m", "fixture"]);

      const valid = await auditRepositoryAnchoredFreeze({
        repositoryRoot: root,
        freezePath
      });
      expect(valid.valid).toBe(true);
      expect(valid.tracked_file_count).toBe(1);
      expect(valid.generated_file_count).toBe(1);

      await fs.writeFile(path.join(root, "src", "input.ts"), "changed\n");
      const changedTracked = await auditRepositoryAnchoredFreeze({
        repositoryRoot: root,
        freezePath
      });
      expect(changedTracked.valid).toBe(false);
      expect(changedTracked.reason_codes).toContain(
        "freeze_binding_current_hash_mismatch"
      );

      await fs.writeFile(path.join(root, "src", "input.ts"), source);
      await fs.writeFile(path.join(root, "dist", "input.js"), "changed\n");
      const changedGenerated = await auditRepositoryAnchoredFreeze({
        repositoryRoot: root,
        freezePath
      });
      expect(changedGenerated.valid).toBe(false);
      expect(changedGenerated.reason_codes).toContain(
        "freeze_binding_current_hash_mismatch"
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a jointly rewritten freeze receipt that is not present at the commit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-anchor-untracked-"));
    try {
      await fs.mkdir(path.join(root, "method"), { recursive: true });
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      const source = "tracked\n";
      await fs.writeFile(path.join(root, "src", "input.txt"), source);
      git(root, ["init", "-b", "main"]);
      git(root, ["config", "user.email", "fixture@example.invalid"]);
      git(root, ["config", "user.name", "Fixture"]);
      git(root, ["add", "src/input.txt"]);
      git(root, ["commit", "-m", "fixture"]);
      const freezePath = path.join(root, "method", "freeze.json");
      await fs.writeFile(freezePath, `${JSON.stringify({
        schema_version: "1.0",
        repository_anchor: {
          required: true,
          tracked_commit_required: true,
          generated_files: []
        },
        files: { "../src/input.txt": sha256(source) }
      })}\n`);

      const audit = await auditRepositoryAnchoredFreeze({
        repositoryRoot: root,
        freezePath
      });
      expect(audit.valid).toBe(false);
      expect(audit.reason_codes).toContain("freeze_not_tracked_at_commit");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
