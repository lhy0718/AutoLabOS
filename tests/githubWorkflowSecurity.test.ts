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
        schedule?: { interval?: string };
        groups?: Record<
          string,
          {
            "applies-to"?: string;
            patterns?: string[];
            "update-types"?: string[];
          }
        >;
      }>;
    };
    const findUpdate = (ecosystem: string, directory: string) =>
      config.updates?.find(
        (update) =>
          update["package-ecosystem"] === ecosystem && update.directory === directory
      );
    const actionsUpdate = findUpdate("github-actions", "/");
    const rootNpmUpdate = findUpdate("npm", "/");
    const webNpmUpdate = findUpdate("npm", "/web");

    expect(config.version).toBe(2);
    expect(actionsUpdate).toMatchObject({
      directory: "/",
      schedule: { interval: "weekly" }
    });
    expect(rootNpmUpdate).toMatchObject({
      directory: "/",
      schedule: { interval: "weekly" }
    });
    expect(rootNpmUpdate?.groups).toEqual({
      "root-npm-minor-patch": {
        "applies-to": "version-updates",
        patterns: ["*"],
        "update-types": ["minor", "patch"]
      }
    });
    expect(webNpmUpdate).toMatchObject({
      directory: "/web",
      schedule: { interval: "weekly" }
    });
    expect(webNpmUpdate?.groups).toEqual({
      "web-npm-minor-patch": {
        "applies-to": "version-updates",
        patterns: ["*"],
        "update-types": ["minor", "patch"]
      }
    });
  });
});
