import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowFiles = ["ci.yml", "smoke.yml"];

describe("GitHub workflow dependency security", () => {
  it("pins external actions to immutable commit SHAs", async () => {
    for (const workflowFile of workflowFiles) {
      const source = await readFile(
        path.join(repoRoot, ".github", "workflows", workflowFile),
        "utf8"
      );
      const references = [...source.matchAll(/uses:\s+([^\s@]+)@([^\s#]+)(?:\s+#\s+([^\s]+))?/gu)];

      expect(references.length, workflowFile).toBeGreaterThan(0);
      for (const reference of references) {
        expect(reference[2], `${workflowFile}:${reference[1]}`).toMatch(/^[0-9a-f]{40}$/u);
        expect(reference[3], `${workflowFile}:${reference[1]} release comment`).toMatch(/^v\d/u);
      }
    }
  });

  it("audits root and web dependencies in CI", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8")
    ) as { scripts?: Record<string, string> };
    const ciSource = await readFile(
      path.join(repoRoot, ".github", "workflows", "ci.yml"),
      "utf8"
    );

    expect(packageJson.scripts?.["audit:security"]).toBe(
      "npm audit --audit-level=moderate && npm --prefix web audit --audit-level=moderate"
    );
    expect(ciSource).toContain("run: npm run audit:security");
  });

  it("installs web dependencies without rewriting the lockfile", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8")
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.["web:install"]).toBe("npm --prefix web ci");
  });

  it("tests every supported Node release line in CI", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8")
    ) as { engines?: { node?: string } };
    const packageLock = JSON.parse(
      await readFile(path.join(repoRoot, "package-lock.json"), "utf8")
    ) as { packages?: { ""?: { engines?: { node?: string } } } };
    const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
    const workflow = YAML.parse(
      await readFile(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8")
    ) as {
      jobs?: {
        "build-and-test"?: {
          steps?: Array<{
            name?: string;
            with?: { "node-version"?: string };
          }>;
        };
        "node-compatibility"?: {
          strategy?: {
            "fail-fast"?: boolean;
            matrix?: { "node-version"?: string[] };
          };
          steps?: Array<{
            name?: string;
            run?: string;
            with?: { "node-version"?: string };
          }>;
        };
      };
    };
    const primarySetup = workflow.jobs?.["build-and-test"]?.steps?.find(
      (step) => step.name === "Setup Node"
    );
    const compatibility = workflow.jobs?.["node-compatibility"];
    const compatibilitySetup = compatibility?.steps?.find(
      (step) => step.name === "Setup Node"
    );

    expect(packageJson.engines?.node).toBe("22.x || 24.x || 26.x");
    expect(packageLock.packages?.[""]?.engines?.node).toBe(packageJson.engines?.node);
    expect(readme).toContain("Node-22.x%20%7C%2024.x%20%7C%2026.x");
    expect(primarySetup?.with?.["node-version"]).toBe("22");
    expect(compatibility?.strategy).toEqual({
      "fail-fast": false,
      matrix: { "node-version": ["24", "26"] }
    });
    expect(compatibilitySetup?.with?.["node-version"]).toBe("${{ matrix.node-version }}");
    expect(compatibility?.steps?.map((step) => step.run).filter(Boolean)).toEqual([
      "npm ci",
      "npm run build",
      "npm run typecheck:ts7-native",
      "npm test"
    ]);
  });

  it("validates the harness with an ephemeral domain-neutral issue log", async () => {
    const workflow = YAML.parse(
      await readFile(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8")
    ) as {
      jobs?: {
        "build-and-test"?: {
          steps?: Array<{ name?: string; run?: string }>;
        };
      };
    };
    const step = workflow.jobs?.["build-and-test"]?.steps?.find(
      (candidate) => candidate.name === "Validate harness records"
    );
    const run = step?.run || "";

    expect(run).toContain("writeFileSync('ISSUES.md'");
    expect(run).toContain("## Active issues");
    expect(run).toContain("none");
    expect(run).toContain("npm run validate:harness");
    expect(run.indexOf("writeFileSync")).toBeLessThan(run.indexOf("npm run validate:harness"));
  });

  it("keeps Dependabot enabled for GitHub Actions and npm updates", async () => {
    const config = YAML.parse(
      await readFile(path.join(repoRoot, ".github", "dependabot.yml"), "utf8")
    ) as {
      version?: number;
      updates?: Array<{
        "package-ecosystem"?: string;
        directory?: string;
        directories?: string[];
        schedule?: { interval?: string };
        groups?: Record<
          string,
          {
            "applies-to"?: string;
            patterns?: string[];
            "update-types"?: string[];
          }
        >;
        ignore?: Array<{
          "dependency-name"?: string;
          "update-types"?: string[];
        }>;
      }>;
    };
    const findDirectoryUpdate = (ecosystem: string, directory: string) =>
      config.updates?.find(
        (update) =>
          update["package-ecosystem"] === ecosystem && update.directory === directory
      );
    const actionsUpdate = findDirectoryUpdate("github-actions", "/");
    const npmUpdates = config.updates?.filter(
      (update) => update["package-ecosystem"] === "npm"
    );
    const npmUpdate = npmUpdates?.[0];

    expect(config.version).toBe(2);
    expect(actionsUpdate).toMatchObject({
      directory: "/",
      schedule: { interval: "weekly" }
    });
    expect(npmUpdates).toHaveLength(1);
    expect(npmUpdate).toMatchObject({
      directories: ["/", "/web"],
      schedule: { interval: "weekly" }
    });
    expect(npmUpdate?.groups).toEqual({
      "npm-typescript-major": {
        "applies-to": "version-updates",
        patterns: ["typescript"],
        "update-types": ["major"]
      },
      "npm-vite-toolchain-major": {
        "applies-to": "version-updates",
        patterns: ["vite", "vitest", "@vitejs/plugin-react"],
        "update-types": ["major"]
      },
      "npm-minor-patch": {
        "applies-to": "version-updates",
        patterns: ["*"],
        "update-types": ["minor", "patch"]
      }
    });
    expect(npmUpdate?.ignore).toEqual([
      {
        "dependency-name": "@types/node",
        "update-types": ["version-update:semver-major"]
      },
      {
        "dependency-name": "typescript",
        "update-types": ["version-update:semver-major"]
      },
      {
        "dependency-name": "jsdom",
        "update-types": ["version-update:semver-major"]
      }
    ]);
  });
});
