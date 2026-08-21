import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readmes = [
  "README.md",
  "docs/README.de.md",
  "docs/README.es.md",
  "docs/README.fr.md",
  "docs/README.ja.md",
  "docs/README.ko.md",
  "docs/README.pt.md",
  "docs/README.ru.md",
  "docs/README.zh-CN.md",
  "docs/README.zh-TW.md"
];

describe("localized README runtime badges", () => {
  it("keeps every translation aligned with the supported toolchain", async () => {
    for (const relativePath of readmes) {
      const source = await readFile(path.join(repoRoot, relativePath), "utf8");

      expect(source, relativePath).toContain("TypeScript-6.x");
      expect(source, relativePath).toContain("Node-22.x%20%7C%2024.x%20%7C%2026.x");
      expect(source, relativePath).toContain("React-19-");
    }
  });
});
