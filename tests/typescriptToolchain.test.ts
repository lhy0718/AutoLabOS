import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface PackageManifest {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function readManifest(relativePath: string): Promise<PackageManifest> {
  return JSON.parse(
    await readFile(path.join(repoRoot, relativePath), "utf8")
  ) as PackageManifest;
}

describe("TypeScript compiler transition contract", () => {
  it("keeps the TypeScript 6 API toolchain separate from the native compiler", async () => {
    const rootManifest = await readManifest("package.json");
    expect(rootManifest.scripts?.build).toContain(
      "node ./node_modules/typescript/bin/tsc"
    );

    for (const relativePath of ["package.json", "web/package.json"]) {
      const manifest = await readManifest(relativePath);

      expect(manifest.devDependencies?.typescript, relativePath).toMatch(/^\^6\./u);
      expect(manifest.devDependencies?.["@typescript/native"], relativePath).toMatch(
        /^npm:typescript@\^7\./u
      );
      expect(manifest.scripts?.typecheck, relativePath).toContain(
        "node ./node_modules/typescript/bin/tsc"
      );
      expect(manifest.scripts?.["typecheck:ts7-bridge"], relativePath).toContain(
        "node ./node_modules/typescript/bin/tsc"
      );
      expect(manifest.scripts?.["typecheck:ts7-native"], relativePath).toContain(
        "node ./node_modules/@typescript/native/bin/tsc"
      );
    }
  });

  it("runs both transition checks in the primary CI job", async () => {
    const workflow = YAML.parse(
      await readFile(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8")
    ) as {
      jobs?: {
        "build-and-test"?: { steps?: Array<{ name?: string; run?: string }> };
      };
    };
    const commands = workflow.jobs?.["build-and-test"]?.steps?.map((step) => step.run) ?? [];

    expect(commands).toContain("npm run typecheck:ts7-bridge");
    expect(commands).toContain("npm run typecheck:ts7-native");
  });
});
