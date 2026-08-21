import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

interface AuditSupportManifest {
  schema_version: string;
  files: Array<{
    path: string;
    sha256: string;
    bytes: number;
  }>;
}

const ROOT = process.cwd();
const MANIFEST_NAME = "audit-support-manifest.json";

function findAuditSupportManifests(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findAuditSupportManifests(absolutePath);
    return entry.isFile() && entry.name === MANIFEST_NAME ? [absolutePath] : [];
  });
}

describe("checked-in audit support manifests", () => {
  it("binds every declared regular file to its current byte length and SHA-256 when a manifest is checked in", () => {
    const manifests = findAuditSupportManifests(path.join(ROOT, "papers"));

    for (const manifestPath of manifests) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as AuditSupportManifest;
      expect(manifest.schema_version).toBe("1.0");
      expect(manifest.files.length).toBeGreaterThan(0);

      for (const entry of manifest.files) {
        const absolutePath = path.resolve(ROOT, entry.path);
        const relativePath = path.relative(ROOT, absolutePath);
        expect(relativePath).not.toBe("");
        expect(relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)).toBe(false);

        const stat = fs.lstatSync(absolutePath);
        expect(stat.isSymbolicLink()).toBe(false);
        expect(stat.isFile()).toBe(true);
        const bytes = fs.readFileSync(absolutePath);
        expect(bytes.byteLength).toBe(entry.bytes);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);
      }
    }
  });
});
