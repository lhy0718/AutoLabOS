import { describe, expect, it } from "vitest";

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const CODE_DIRS = ["src", "tests"];
const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function walkCodeFiles(dir: string): string[] {
  const absolute = path.join(ROOT, dir);
  const entries = fs.readdirSync(absolute, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", ".git"].includes(entry.name)) {
        return [];
      }
      return walkCodeFiles(entryPath);
    }
    if (!entry.isFile() || !TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      return [];
    }
    return [entryPath];
  });
}

function joinParts(...parts: string[]): string {
  return parts.join("");
}

describe("public code sanitization", () => {
  it("does not expose one-off experiment identifiers in source or tests", () => {
    const banned = [
      joinParts("run", "_", "peft", "_", "instruction", "_", "study"),
      joinParts("execute", "_", "peft", "_", "instruction", "_", "study"),
      joinParts("run", "_", "lora", "_", "rank", "_", "dropout", "_", "study"),
      joinParts("arc", "_", "challenge"),
      joinParts("hella", "swag"),
      joinParts("ARC", "-", "Challenge"),
      joinParts("Hella", "Swag"),
      joinParts("Qwen", "/", "Qwen2", ".", "5"),
      joinParts("Tiny", "Llama", "/", "Tiny", "Llama"),
      joinParts("LoRA", " rank", "/", "dropout"),
      joinParts("rank", "_", "8", "_", "dropout", "_", "0", "_", "0"),
      joinParts("rank", "-", "32"),
      joinParts("dropout", "-", "0", ".", "05")
    ];

    const offenders = CODE_DIRS.flatMap(walkCodeFiles).flatMap((relativePath) => {
      const text = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
      return banned
        .filter((pattern) => text.includes(pattern))
        .map((pattern) => ({ relativePath, pattern }));
    });

    expect(offenders).toEqual([]);
  });
});
