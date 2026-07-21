import { describe, expect, it } from "vitest";

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SANITIZER_TEST_PATH = path.join("tests", "publicCodeSanitization.test.ts");
const PUBLIC_DIRS = [
  ".agents",
  "src",
  "tests",
  "docs",
  "scripts",
  "papers",
  "benchmarks",
  "node-prompts",
  "plugins",
  "web",
  ".github",
  path.join(".codex", "skills")
];
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".md",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".tex",
  ".py",
  ".sh",
  ".example"
]);
const ROOT_TEXT_FILENAMES = new Set([".gitattributes", ".gitignore"]);
const HISTORICAL_AUDIT_FILES = new Set(["ISSUES.md"]);

function walkTextFiles(dir: string): string[] {
  const absolute = path.join(ROOT, dir);
  if (!fs.existsSync(absolute)) {
    return [];
  }
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const portablePath = relativePath.split(path.sep).join("/");
      const localRefgateCache = portablePath.endsWith("/.refgate/cache");
      return ["node_modules", "dist", ".git"].includes(entry.name) || localRefgateCache
        ? []
        : walkTextFiles(relativePath);
    }
    return entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name)) ? [relativePath] : [];
  });
}

function publicTextFiles(options: { includeAuditLog?: boolean } = {}): string[] {
  const dirs = PUBLIC_DIRS;
  const rootFiles = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (
      TEXT_EXTENSIONS.has(path.extname(entry.name))
      || ROOT_TEXT_FILENAMES.has(entry.name)
    ))
    .map((entry) => entry.name);
  return [...new Set([...dirs.flatMap(walkTextFiles), ...rootFiles])].filter((relativePath) => {
    if (relativePath === SANITIZER_TEST_PATH) {
      return false;
    }
    return options.includeAuditLog || !HISTORICAL_AUDIT_FILES.has(relativePath);
  });
}

function collectPatternOffenders(
  files: string[],
  patterns: ReadonlyArray<{ kind: string; pattern: RegExp }>
): Array<{ relativePath: string; kind: string }> {
  return files.flatMap((relativePath) => {
    const source = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
    return patterns
      .filter(({ pattern }) => {
        pattern.lastIndex = 0;
        return pattern.test(source);
      })
      .map(({ kind }) => ({ relativePath, kind }));
  });
}

const GENERIC_ENTRYPOINT_TOKENS = new Set([
  "all",
  "analysis",
  "and",
  "baseline",
  "bounded",
  "candidate",
  "comparison",
  "condition",
  "configured",
  "control",
  "dynamic",
  "experiment",
  "failure",
  "finalize",
  "first",
  "full",
  "grid",
  "local",
  "locked",
  "ordered",
  "parameterized",
  "planned",
  "primary",
  "public",
  "real",
  "safe",
  "secondary",
  "seed",
  "single",
  "study",
  "sweep",
  "validation",
  "workflow"
]);

function collectExperimentSpecificEntrypoints(
  files: string[]
): Array<{ relativePath: string; identifier: string; domainTokens: string[] }> {
  const entrypointPattern = /\b(?:run|execute|orchestrate)_([a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)*)_(?:study|sweep|experiment)\b/gu;
  return files.flatMap((relativePath) => {
    const source = fs.readFileSync(path.join(ROOT, relativePath), "utf8");
    return [...source.matchAll(entrypointPattern)].flatMap((match) => {
      const domainTokens = match[1].split("_").filter((token) => !GENERIC_ENTRYPOINT_TOKENS.has(token));
      return domainTokens.length > 0
        ? [{ relativePath, identifier: match[0], domainTokens }]
        : [];
    });
  });
}

describe("public code sanitization", () => {
  it("rejects experiment-specific entrypoints and encoded numeric condition names", () => {
    const files = publicTextFiles();
    const structuralHardcodingPatterns = [
      {
        kind: "encoded_numeric_condition_name",
        pattern:
          /\b(?!(?:condition|score)_)[a-z][a-z0-9]*_\d+(?:_\d+)?_(?!to_)[a-z][a-z0-9]*_\d+(?:_\d+)?\b/giu
      },
      {
        kind: "encoded_literal_from_character_codes",
        pattern: /String\.fromCharCode\(\s*\d+(?:\s*,\s*\d+){3,}\s*\)/gu
      }
    ];

    expect(collectExperimentSpecificEntrypoints(files)).toEqual([]);
    expect(collectPatternOffenders(files, structuralHardcodingPatterns)).toEqual([]);
  });

  it("rejects live service identifiers and developer-machine paths in public text", () => {
    const patterns = [
      {
        kind: "uuid",
        pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu
      },
      {
        kind: "request_id",
        pattern: /\b(?:req|request|resp)_[A-Za-z0-9]{20,}\b/gu
      },
      {
        kind: "thread_id",
        pattern: /\b(?:thread|thr)_[A-Za-z0-9]{20,}\b/gu
      },
      {
        kind: "event_trace_id",
        pattern: /\b(?:event|evt|span|trace)_(?=[A-Za-z0-9._-]*\d)[A-Za-z0-9][A-Za-z0-9._-]{11,}\b/gu
      },
      {
        kind: "posix_developer_home",
        pattern: /(?:^|[\s"'`(])\/(?:home|Users)\/[A-Za-z0-9._-]+\//gmu
      },
      {
        kind: "windows_developer_home",
        pattern: /\b[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/gu
      },
      {
        kind: "macos_private_temp",
        pattern: /(?:^|[\s"'`(])\/(?:private\/)?var\/folders\/[A-Za-z0-9._-]+\//gmu
      }
    ];
    const files = publicTextFiles();

    expect(files).toContain("README.md");
    expect(files).toContain(".env.example");
    expect(files).toContain(path.join(".agents", "plugins", "marketplace.json"));
    expect(files).toContain(path.join(".github", "workflows", "ci.yml"));
    expect(files).toContain(path.join("web", "src", "App.tsx"));
    expect(files).toContain(path.join("tests", "implementationLocalizer.test.ts"));
    expect(files).toContain(path.join("scripts", "live-validation-start-run.py"));
    expect(collectPatternOffenders(files, patterns)).toEqual([]);
  });

  it("keeps verification immutable and free of source-repair hooks", () => {
    const source = fs.readFileSync(
      path.join(ROOT, "src", "core", "agents", "implementSessionManager.ts"),
      "utf8"
    );
    const start = source.indexOf("  private async verifyAttempt(");
    const end = source.indexOf("\n  }\n}\n\nasync function writeImplementProgressStatus", start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const verifyAttemptSource = source.slice(start, end);
    expect(verifyAttemptSource).toContain("this.deps.aci.runTests");
    expect(verifyAttemptSource).not.toMatch(/\b(?:writeFile|appendFile|applyPatch|replaceFile)\b/u);
    expect(verifyAttemptSource).not.toMatch(/\brepair[A-Z][A-Za-z0-9]*\s*\(/u);
  });

  it("does not retain retired compatibility terminology in public files", () => {
    const offenders = collectPatternOffenders(publicTextFiles({ includeAuditLog: true }), [
      { kind: "retired_compatibility_term", pattern: /\blegacy\b/giu }
    ]);

    expect(offenders).toEqual([]);
  });
});
