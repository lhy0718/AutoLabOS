import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { resolveCliAction } from "../src/cli/args.js";

describe("resolveCliAction", () => {
  it("runs app when no args", () => {
    expect(resolveCliAction([])).toEqual({ kind: "run" });
  });

  it("supports node option package selection for run mode", () => {
    expect(resolveCliAction(["--package", "fast"])).toEqual({ kind: "run", packageName: "fast" });
  });

  it("supports benchmark condition selection for TUI run mode", () => {
    expect(resolveCliAction(["--benchmark-condition", "gated"])).toEqual({
      kind: "run",
      benchmarkCondition: "gated"
    });
    expect(resolveCliAction(["--package", "fast", "--benchmark-condition", "ungated"])).toEqual({
      kind: "run",
      packageName: "fast",
      benchmarkCondition: "ungated"
    });
  });

  it("supports --help", () => {
    expect(resolveCliAction(["--help"]).kind).toBe("help");
  });

  it("supports audit-specific help", () => {
    expect(resolveCliAction(["audit", "--help"]).kind).toBe("audit-help");
    expect(resolveCliAction(["audit", "-h"]).kind).toBe("audit-help");
  });

  it("prints support intake options in audit-specific help", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli/main.ts", "audit", "--help"],
      { cwd: process.cwd(), encoding: "utf8" }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("[--support-root <root> --support-manifest <manifest.json>]");
  });

  it("supports reference claim review handoff and preflight", () => {
    expect(resolveCliAction([
      "reference-review", "prepare",
      "--claims", "paper/claims.tsv",
      "--status", "paper/reference-status.json",
      "--lock", "paper/refgate.lock.json",
      "--out-dir", "paper/review-handoff"
    ])).toEqual({
      kind: "reference-review-prepare",
      claimsPath: "paper/claims.tsv",
      statusPath: "paper/reference-status.json",
      lockPath: "paper/refgate.lock.json",
      outDir: "paper/review-handoff"
    });
    expect(resolveCliAction([
      "reference-review", "distribute-private",
      "--packet", "paper/review-handoff",
      "--source-dir", "private/full-text",
      "--out-dir", "private/review-distribution"
    ])).toEqual({
      kind: "reference-review-distribute-private",
      packetRoot: "paper/review-handoff",
      sourceDir: "private/full-text",
      outDir: "private/review-distribution"
    });
    expect(resolveCliAction([
      "reference-review", "package-private",
      "--distribution", "private/review-distribution",
      "--out-dir", "private/reviewer-package"
    ])).toEqual({
      kind: "reference-review-package-private",
      distributionRoot: "private/review-distribution",
      outDir: "private/reviewer-package"
    });
    expect(resolveCliAction([
      "reference-review", "verify-private-package",
      "--package", "private/reviewer-package"
    ])).toEqual({
      kind: "reference-review-verify-private-package",
      packageRoot: "private/reviewer-package"
    });
    expect(resolveCliAction([
      "reference-review", "prepare-workspace",
      "--package", "private/reviewer-package",
      "--out-dir", "private/review-workspace"
    ])).toEqual({
      kind: "reference-review-prepare-workspace",
      packageRoot: "private/reviewer-package",
      outDir: "private/review-workspace"
    });
    expect(resolveCliAction([
      "reference-review", "audit-workspace",
      "--workspace", "private/review-workspace",
      "--out-dir", "private/review-workspace-audit"
    ])).toEqual({
      kind: "reference-review-audit-workspace",
      workspaceRoot: "private/review-workspace",
      outDir: "private/review-workspace-audit"
    });
    expect(resolveCliAction([
      "reference-review", "finalize-workspace",
      "--workspace", "private/review-workspace",
      "--output", "returns/review.json"
    ])).toEqual({
      kind: "reference-review-finalize-workspace",
      workspaceRoot: "private/review-workspace",
      outputPath: "returns/review.json"
    });
    expect(resolveCliAction([
      "reference-review", "preflight",
      "--packet", "paper/review-handoff",
      "--review", "returns/review.json",
      "--out-dir", "paper/review-preflight"
    ])).toEqual({
      kind: "reference-review-preflight",
      packetRoot: "paper/review-handoff",
      reviewPath: "returns/review.json",
      outDir: "paper/review-preflight"
    });
    expect(resolveCliAction([
      "reference-review", "import",
      "--packet", "paper/review-handoff",
      "--review", "returns/review.json",
      "--preflight", "paper/review-preflight/reference-claim-review-preflight.json",
      "--approval", "returns/final-approval.json",
      "--claims", "paper/claims.tsv",
      "--out-dir", "paper/review-import"
    ])).toEqual({
      kind: "reference-review-import",
      packetRoot: "paper/review-handoff",
      reviewPath: "returns/review.json",
      preflightReportPath: "paper/review-preflight/reference-claim-review-preflight.json",
      approvalPath: "returns/final-approval.json",
      claimsPath: "paper/claims.tsv",
      outDir: "paper/review-import"
    });
  });

  it("rejects incomplete reference claim review arguments", () => {
    expect(resolveCliAction([
      "reference-review", "prepare", "--claims", "claims.tsv"
    ])).toMatchObject({ kind: "error", message: expect.stringContaining("requires") });
    expect(resolveCliAction([
      "reference-review", "distribute-private", "--packet", "packet"
    ])).toMatchObject({ kind: "error", message: expect.stringContaining("requires") });
    expect(resolveCliAction([
      "reference-review", "preflight", "--packet", "packet"
    ])).toMatchObject({ kind: "error", message: expect.stringContaining("requires") });
    expect(resolveCliAction([
      "reference-review", "package-private", "--distribution", "private-distribution"
    ])).toMatchObject({ kind: "error", message: expect.stringContaining("requires") });
    expect(resolveCliAction([
      "reference-review", "import", "--packet", "packet", "--review", "review.json"
    ])).toMatchObject({ kind: "error", message: expect.stringContaining("requires") });
    expect(resolveCliAction([
      "reference-review", "verify-private-package"
    ])).toMatchObject({ kind: "error", message: expect.stringContaining("requires") });
    expect(resolveCliAction([
      "reference-review", "prepare-workspace", "--package", "private-package"
    ])).toMatchObject({ kind: "error", message: expect.stringContaining("requires") });
    expect(resolveCliAction([
      "reference-review", "audit-workspace", "--workspace", "review-workspace"
    ])).toMatchObject({ kind: "error", message: expect.stringContaining("requires") });
    expect(resolveCliAction([
      "reference-review", "finalize-workspace", "--workspace", "review-workspace"
    ])).toMatchObject({ kind: "error", message: expect.stringContaining("requires") });
  });

  it("supports web mode with host and port", () => {
    expect(resolveCliAction(["web", "--host", "0.0.0.0", "--port", "3001"])).toEqual({
      kind: "web",
      host: "0.0.0.0",
      port: 3001
    });
  });

  it("supports benchmark condition selection for web mode", () => {
    expect(resolveCliAction(["web", "--benchmark-condition", "no_review_gate"])).toEqual({
      kind: "web",
      benchmarkCondition: "no_review_gate"
    });
  });

  it("supports compare-analysis mode", () => {
    expect(resolveCliAction(["compare-analysis", "--run", "run-123", "--limit", "5", "--no-judge"])).toEqual({
      kind: "compare-analysis",
      runId: "run-123",
      limit: 5,
      judge: false
    });
  });

  it("supports eval-harness mode", () => {
    expect(resolveCliAction(["eval-harness", "--run", "run-123", "--run", "run-456", "--limit", "5", "--output", "outputs/eval.json"])).toEqual({
      kind: "eval-harness",
      runIds: ["run-123", "run-456"],
      limit: 5,
      outputPath: "outputs/eval.json",
      noHistory: false
    });
  });

  it("supports eval-harness --no-history", () => {
    expect(resolveCliAction(["eval-harness", "--limit", "5", "--no-history"])).toEqual({
      kind: "eval-harness",
      runIds: [],
      limit: 5,
      outputPath: undefined,
      noHistory: true
    });
  });

  it("supports evolve mode", () => {
    expect(resolveCliAction(["evolve", "--max-cycles", "2", "--target", "prompts", "--dry-run"])).toEqual({
      kind: "evolve",
      maxCycles: 2,
      target: "prompts",
      dryRun: true
    });
  });

  it("supports paper-readiness audit by run and external artifact roots", () => {
    expect(resolveCliAction(["audit", "--run", "outputs/run-a"])).toEqual({
      kind: "audit",
      runRoot: "outputs/run-a",
      externalRoot: undefined,
      draftPath: undefined,
      logPath: undefined,
      supportRoot: undefined,
      supportManifestPath: undefined,
      outDir: undefined
    });
    expect(resolveCliAction(["audit", "--external", "incoming/run-a", "--draft", "incoming/draft.md", "--log", "incoming/run.log"])).toEqual({
      kind: "audit",
      runRoot: undefined,
      externalRoot: "incoming/run-a",
      draftPath: "incoming/draft.md",
      logPath: "incoming/run.log",
      supportRoot: undefined,
      supportManifestPath: undefined,
      outDir: undefined
    });
  });

  it("parses explicit support-manifest intake only for external audits", () => {
    expect(resolveCliAction([
      "audit",
      "--external", "incoming/package",
      "--support-root", ".",
      "--support-manifest", "incoming/support-manifest.json"
    ])).toMatchObject({
      kind: "audit",
      supportRoot: ".",
      supportManifestPath: "incoming/support-manifest.json"
    });
    expect(resolveCliAction([
      "research",
      "audit",
      "--external", "incoming/package",
      "--support-root", ".",
      "--support-manifest", "incoming/support-manifest.json"
    ])).toMatchObject({
      kind: "research-audit",
      supportRoot: ".",
      supportManifestPath: "incoming/support-manifest.json"
    });
    expect(resolveCliAction([
      "audit", "--external", "incoming/package", "--support-root", "."
    ])).toMatchObject({ kind: "error", message: expect.stringContaining("supplied together") });
    expect(resolveCliAction([
      "research", "audit", "--run", "outputs/run-a",
      "--support-root", ".",
      "--support-manifest", "support.json"
    ])).toMatchObject({ kind: "error", message: expect.stringContaining("require --external") });
  });

  it("requires exactly one paper-readiness audit input", () => {
    expect(resolveCliAction(["audit"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--run")
    });
    expect(resolveCliAction(["audit", "--run", "outputs/run-a", "--seed", "case-alpha"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--seed")
    });
    expect(resolveCliAction(["audit", "--draft", "draft.md"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--external")
    });
  });

  it("supports meta-harness mode", () => {
    expect(resolveCliAction(["meta-harness", "--runs", "2", "--node", "design_experiments", "--node", "review", "--no-apply"])).toEqual({
      kind: "meta-harness",
      runs: 2,
      nodes: ["design_experiments", "review"],
      externalRunRoots: [],
      noApply: true,
      dryRun: false
    });
  });

  it("supports read-only external meta-harness contexts", () => {
    expect(resolveCliAction(["meta-harness", "--external-run", "runs/run-a", "--external-run", "runs/run-b", "--no-apply"])).toEqual({
      kind: "meta-harness",
      runs: 0,
      nodes: ["analyze_results", "review"],
      externalRunRoots: ["runs/run-a", "runs/run-b"],
      noApply: true,
      dryRun: false
    });
  });

  it("rejects external meta-harness contexts outside read-only mode", () => {
    expect(resolveCliAction(["meta-harness", "--external-run", "runs/run-a"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--no-apply")
    });
    expect(resolveCliAction(["meta-harness", "--external-run", "runs/run-a", "--dry-run", "--no-apply"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--dry-run")
    });
    expect(resolveCliAction(["meta-harness", "--external-run", "runs/run-a", "--runs", "2", "--no-apply"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--runs")
    });
  });

  it("supports hash-bound research validation profiles", () => {
    expect(resolveCliAction([
      "research", "run-validation",
      "--profile", "docs/research/final-validation-profile.json",
      "--out-dir", "outputs/research-validation-v1"
    ])).toEqual({
      kind: "research-validation-run",
      profilePath: "docs/research/final-validation-profile.json",
      outDir: "outputs/research-validation-v1"
    });
    expect(resolveCliAction([
      "research", "run-validation",
      "--profile", "docs/research/final-validation-profile.json"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--profile")
    });
  });

  it("supports optional A2 model-review evidence for research review", () => {
    expect(resolveCliAction([
      "research", "review",
      "--gate", "artifacts/gate-report.json",
      "--out-dir", "outputs/review"
    ])).toEqual({
      kind: "research-review",
      gatePath: "artifacts/gate-report.json",
      outDir: "outputs/review"
    });
    expect(resolveCliAction([
      "research", "review",
      "--gate", "artifacts/gate-report.json",
      "--model-review", "artifacts/model-review-bundle.json",
      "--out-dir", "outputs/review"
    ])).toEqual({
      kind: "research-review",
      gatePath: "artifacts/gate-report.json",
      modelReviewBundlePath: "artifacts/model-review-bundle.json",
      outDir: "outputs/review"
    });
  });

  it("fails closed on malformed research review arguments", () => {
    expect(resolveCliAction([
      "research", "review",
      "--gate", "artifacts/gate-report.json",
      "--model-review", "artifacts/model-review-bundle.json",
      "--model-review", "artifacts/second-model-review-bundle.json"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Duplicate research argument: --model-review")
    });
    expect(resolveCliAction([
      "research", "review",
      "--gate", "artifacts/gate-report.json",
      "--model-review"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Missing value for --model-review")
    });
    expect(resolveCliAction([
      "research", "review",
      "--gate", "artifacts/gate-report.json",
      "--unsupported", "value"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Unsupported research review argument: --unsupported")
    });
  });

  it("requires a run id for compare-analysis", () => {
    const action = resolveCliAction(["compare-analysis"]);
    expect(action.kind).toBe("error");
  });

  it("rejects init subcommand", () => {
    const action = resolveCliAction(["init"]);
    expect(action.kind).toBe("error");
  });

  it("rejects unknown package names", () => {
    const action = resolveCliAction(["--package", "turbo"]);
    expect(action.kind).toBe("error");
  });
});
