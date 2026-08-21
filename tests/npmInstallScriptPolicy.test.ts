import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface PackageJson {
  allowScripts?: Record<string, boolean>;
}

interface PackageLock {
  packages?: Record<
    string,
    {
      hasInstallScript?: boolean;
      version?: string;
    }
  >;
}

function dependencyName(packagePath: string): string {
  const relativePath = packagePath.split("node_modules/").at(-1) ?? "";
  const segments = relativePath.split("/");
  return relativePath.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0] ?? "";
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

describe("npm dependency install-script policy", () => {
  for (const directory of [".", "web"]) {
    it(`pins an explicit decision for every install script in ${directory}`, async () => {
      const packageJson = await readJson<PackageJson>(
        path.join(repoRoot, directory, "package.json")
      );
      const packageLock = await readJson<PackageLock>(
        path.join(repoRoot, directory, "package-lock.json")
      );
      const expectedKeys = [
        ...new Set(
          Object.entries(packageLock.packages ?? {})
            .filter(([, metadata]) => metadata.hasInstallScript === true)
            .map(([packagePath, metadata]) => {
              const name = dependencyName(packagePath);
              expect(name, packagePath).not.toBe("");
              expect(metadata.version, packagePath).toBeTruthy();
              return `${name}@${metadata.version}`;
            })
        )
      ].sort();
      const decisions = packageJson.allowScripts ?? {};

      expect(Object.keys(decisions).sort()).toEqual(expectedKeys);
      for (const key of expectedKeys) {
        expect(decisions[key], key).toBe(true);
      }
    });
  }
});
