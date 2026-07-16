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
      outDir: undefined
    });
    expect(resolveCliAction(["audit", "--external", "incoming/run-a", "--draft", "incoming/draft.md", "--log", "incoming/run.log"])).toEqual({
      kind: "audit",
      runRoot: undefined,
      externalRoot: "incoming/run-a",
      draftPath: "incoming/draft.md",
      logPath: "incoming/run.log",
      outDir: undefined
    });
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

  it("supports governance benchmark seed import mode", () => {
    expect(
      resolveCliAction([
        "governance-benchmark",
        "seed",
        "--source",
        "fixtures/case-alpha",
        "--task",
        "case-alpha",
        "--out-dir",
        "outputs/seeds",
        "--reference-only"
      ])
    ).toEqual({
      kind: "governance-benchmark-seed",
      sourcePath: "fixtures/case-alpha",
      taskId: "case-alpha",
      outDir: "outputs/seeds",
      referenceOnly: true
    });
  });

  it("supports governance benchmark dry-run mode", () => {
    expect(
      resolveCliAction([
        "governance-benchmark",
        "dry-run",
        "--seed",
        "outputs/governance-benchmark/seeds/case-alpha",
        "--task",
        "case-alpha",
        "--condition",
        "gated",
        "--condition",
        "ungated",
        "--out-dir",
        "outputs/governance-benchmark/case-alpha"
      ])
    ).toEqual({
      kind: "governance-benchmark-dry-run",
      seedPath: "outputs/governance-benchmark/seeds/case-alpha",
      taskId: "case-alpha",
      conditions: ["gated", "ungated"],
      outDir: "outputs/governance-benchmark/case-alpha"
    });
  });

  it("supports governance benchmark batch mode", () => {
    expect(
      resolveCliAction([
        "governance-benchmark",
        "batch",
        "--seeds",
        "outputs/governance-benchmark/seeds",
        "--task",
        "case-alpha",
        "--task",
        "case-beta",
        "--condition",
        "gated",
        "--condition",
        "ungated",
        "--out-dir",
        "outputs/governance-benchmark/batch"
      ])
    ).toEqual({
      kind: "governance-benchmark-batch",
      seedsRoot: "outputs/governance-benchmark/seeds",
      taskIds: ["case-alpha", "case-beta"],
      conditions: ["gated", "ungated"],
      outDir: "outputs/governance-benchmark/batch"
    });
  });

  it("supports governance benchmark demo bundle export mode", () => {
    expect(
      resolveCliAction([
        "governance-benchmark",
        "export-bundles",
        "--source",
        "outputs/run-a",
        "--source",
        "outputs/run-b",
        "--max",
        "3",
        "--out-dir",
        "outputs/governance-benchmark/demo-bundles"
      ])
    ).toEqual({
      kind: "governance-benchmark-export-bundles",
      publicOutputRoots: ["outputs/run-a", "outputs/run-b"],
      maxBundles: 3,
      outDir: "outputs/governance-benchmark/demo-bundles"
    });
  });

  it("supports promotion benchmark scoring mode", () => {
    expect(
      resolveCliAction([
        "governance-benchmark",
        "score-promotion",
        "--suite",
        "benchmarks/promotion/suite.json",
        "--predictions",
        "outputs/predictions.jsonl",
        "--out-dir",
        "outputs/promotion-score"
      ])
    ).toEqual({
      kind: "governance-benchmark-score-promotion",
      suitePath: "benchmarks/promotion/suite.json",
      predictionsPath: "outputs/predictions.jsonl",
      outDir: "outputs/promotion-score"
    });
  });

  it("supports promotion benchmark build mode", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "build-promotion",
      "--recipe",
      "benchmarks/promotion/recipe.json",
      "--out-dir",
      "outputs/promotion-suite"
    ])).toEqual({
      kind: "governance-benchmark-build-promotion",
      recipePath: "benchmarks/promotion/recipe.json",
      outDir: "outputs/promotion-suite"
    });
  });

  it("supports synthetic promotion development corpus generation", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "generate-promotion-development",
      "--out-dir",
      "outputs/development-corpus"
    ])).toEqual({
      kind: "governance-benchmark-generate-promotion-development",
      outDir: "outputs/development-corpus"
    });
  });

  it("supports confirmatory promotion intake freezing", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "freeze-promotion-confirmatory",
      "--manifest",
      "inputs/confirmatory-intake.json",
      "--out-dir",
      "outputs/confirmatory-corpus"
    ])).toEqual({
      kind: "governance-benchmark-freeze-promotion-confirmatory",
      manifestPath: "inputs/confirmatory-intake.json",
      outDir: "outputs/confirmatory-corpus"
    });
  });

  it("supports fail-closed confirmatory promotion intake auditing", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "audit-promotion-confirmatory",
      "--manifest",
      "inputs/confirmatory-intake.json",
      "--out-dir",
      "outputs/confirmatory-audit"
    ])).toEqual({
      kind: "governance-benchmark-audit-promotion-confirmatory",
      manifestPath: "inputs/confirmatory-intake.json",
      outDir: "outputs/confirmatory-audit"
    });
  });

  it("supports promotion benchmark failure analysis", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "analyze-promotion-failures",
      "--suite",
      "suite.json",
      "--predictions",
      "predictions.jsonl",
      "--system",
      "artifact-audit",
      "--out-dir",
      "outputs/failures"
    ])).toEqual({
      kind: "governance-benchmark-analyze-promotion-failures",
      suitePath: "suite.json",
      predictionsPath: "predictions.jsonl",
      systemId: "artifact-audit",
      outDir: "outputs/failures"
    });
  });

  it("supports promotion benchmark system run mode", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "run-promotion",
      "--suite",
      "outputs/promotion-suite/suite.json",
      "--system",
      "presence-checklist",
      "--system",
      "artifact-audit",
      "--trial",
      "trial-beta",
      "--out-dir",
      "outputs/predictions"
    ])).toEqual({
      kind: "governance-benchmark-run-promotion",
      suitePath: "outputs/promotion-suite/suite.json",
      systems: ["presence-checklist", "artifact-audit"],
      trialId: "trial-beta",
      outDir: "outputs/predictions"
    });
  });

  it("supports promotion prompt export and response import modes", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "export-promotion-prompts",
      "--suite",
      "suite.json",
      "--out-dir",
      "outputs/prompts"
    ])).toEqual({
      kind: "governance-benchmark-export-promotion-prompts",
      suitePath: "suite.json",
      outDir: "outputs/prompts"
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "import-promotion-responses",
      "--map",
      "private-map.json",
      "--responses",
      "responses.jsonl",
      "--system",
      "provider-alpha",
      "--trial",
      "trial-alpha"
    ])).toEqual({
      kind: "governance-benchmark-import-promotion-responses",
      requestMapPath: "private-map.json",
      responsesPath: "responses.jsonl",
      systemId: "provider-alpha",
      trialId: "trial-alpha",
      outDir: "outputs/governance-benchmark/provider-predictions"
    });
  });

  it("supports blind promotion annotation export and double adjudication", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "export-promotion-annotations",
      "--suite",
      "suite.json",
      "--out-dir",
      "outputs/annotations"
    ])).toEqual({
      kind: "governance-benchmark-export-promotion-annotations",
      suitePath: "suite.json",
      outDir: "outputs/annotations"
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "adjudicate-promotion",
      "--suite",
      "suite.json",
      "--map",
      "private-map.json",
      "--annotations",
      "labels-a.jsonl",
      "--annotations",
      "labels-b.jsonl",
      "--resolution",
      "resolution.jsonl",
      "--mutation-audit-report",
      "mutation-audit-report.json",
      "--out-dir",
      "outputs/adjudicated"
    ])).toEqual({
      kind: "governance-benchmark-adjudicate-promotion",
      suitePath: "suite.json",
      privateMapPath: "private-map.json",
      annotationPaths: ["labels-a.jsonl", "labels-b.jsonl"],
      resolutionPath: "resolution.jsonl",
      mutationAuditReportPath: "mutation-audit-report.json",
      outDir: "outputs/adjudicated"
    });
  });

  it("supports promotion mutation audit export and double verification", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "export-promotion-mutation-audit",
      "--suite",
      "suite.json",
      "--out-dir",
      "outputs/mutation-audit"
    ])).toEqual({
      kind: "governance-benchmark-export-promotion-mutation-audit",
      suitePath: "suite.json",
      outDir: "outputs/mutation-audit"
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "verify-promotion-mutations",
      "--suite",
      "suite.json",
      "--map",
      "private-mutation-map.json",
      "--audits",
      "audit-a.jsonl",
      "--audits",
      "audit-b.jsonl",
      "--out-dir",
      "outputs/mutation-verification"
    ])).toEqual({
      kind: "governance-benchmark-verify-promotion-mutations",
      suitePath: "suite.json",
      privateMapPath: "private-mutation-map.json",
      auditPaths: ["audit-a.jsonl", "audit-b.jsonl"],
      outDir: "outputs/mutation-verification"
    });
  });

  it("supports preparing promotion execution evidence from six role-bound artifacts", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "prepare-promotion-execution-evidence",
      "--source-root", "outputs/source-bundle",
      "--run-id", "run-neutral-a",
      "--backend", "local_runtime",
      "--started-at", "2026-01-01T00:00:00.000Z",
      "--completed-at", "2026-01-01T00:01:00.000Z",
      "--trial", "trial-a",
      "--trial", "trial-b",
      "--trial", "trial-c",
      "--artifact", "run_config=run-config.json",
      "--artifact", "event_log=events.jsonl",
      "--artifact", "metrics=metrics.json",
      "--artifact", "review_decision=review/decision.json",
      "--artifact", "command=command.txt",
      "--artifact", "execution_log=execution.log"
    ])).toEqual({
      kind: "governance-benchmark-prepare-promotion-execution-evidence",
      sourceRoot: "outputs/source-bundle",
      runId: "run-neutral-a",
      executionBackend: "local_runtime",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      trialIds: ["trial-a", "trial-b", "trial-c"],
      artifacts: [
        { role: "run_config", path: "run-config.json" },
        { role: "event_log", path: "events.jsonl" },
        { role: "metrics", path: "metrics.json" },
        { role: "review_decision", path: "review/decision.json" },
        { role: "command", path: "command.txt" },
        { role: "execution_log", path: "execution.log" }
      ]
    });
  });

  it("supports deterministic projection of an external promotion source", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "project-promotion-source",
      "--source-root", "inputs/raw-source",
      "--recipe", "inputs/projection.json",
      "--out-dir", "outputs/projected-source"
    ])).toEqual({
      kind: "governance-benchmark-project-promotion-source",
      sourceRoot: "inputs/raw-source",
      recipePath: "inputs/projection.json",
      outDir: "outputs/projected-source"
    });
  });

  it("supports blind source-normalization pack export and double-annotation materialization", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "export-promotion-source-normalization",
      "--source-root", "outputs/projected-source",
      "--out-dir", "outputs/normalization-pack"
    ])).toEqual({
      kind: "governance-benchmark-export-promotion-source-normalization",
      sourceRoot: "outputs/projected-source",
      outDir: "outputs/normalization-pack"
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "normalize-promotion-source",
      "--source-root", "outputs/projected-source",
      "--map", "outputs/normalization-pack/private-normalization-map.json",
      "--annotations", "labels-a.jsonl",
      "--annotations", "labels-b.jsonl",
      "--resolution", "labels-resolution.jsonl",
      "--out-dir", "outputs/normalized-source"
    ])).toEqual({
      kind: "governance-benchmark-normalize-promotion-source",
      sourceRoot: "outputs/projected-source",
      privateMapPath: "outputs/normalization-pack/private-normalization-map.json",
      annotationPaths: ["labels-a.jsonl", "labels-b.jsonl"],
      resolutionPath: "labels-resolution.jsonl",
      outDir: "outputs/normalized-source"
    });
  });

  it("requires complete roles and three trials when preparing execution evidence", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "prepare-promotion-execution-evidence",
      "--source-root", "outputs/source-bundle",
      "--run-id", "run-neutral-a",
      "--backend", "local_runtime",
      "--started-at", "2026-01-01T00:00:00.000Z",
      "--completed-at", "2026-01-01T00:01:00.000Z",
      "--trial", "trial-a",
      "--trial", "trial-b"
    ])).toMatchObject({ kind: "error", message: expect.stringContaining("three --trial") });
    expect(resolveCliAction([
      "governance-benchmark",
      "prepare-promotion-execution-evidence",
      "--source-root", "outputs/source-bundle",
      "--run-id", "run-neutral-a",
      "--backend", "local_runtime",
      "--started-at", "2026-01-01T00:00:00.000Z",
      "--completed-at", "2026-01-01T00:01:00.000Z",
      "--trial", "trial-a",
      "--trial", "trial-b",
      "--trial", "trial-c",
      "--artifact", "run_config=run-config.json"
    ])).toMatchObject({ kind: "error", message: expect.stringContaining("roles") });
  });

  it("requires a run id for compare-analysis", () => {
    const action = resolveCliAction(["compare-analysis"]);
    expect(action.kind).toBe("error");
  });

  it("requires a source for governance benchmark seed import mode", () => {
    const action = resolveCliAction(["governance-benchmark", "seed"]);
    expect(action.kind).toBe("error");
  });

  it("requires a seed for governance benchmark dry-run mode", () => {
    const action = resolveCliAction(["governance-benchmark", "dry-run"]);
    expect(action.kind).toBe("error");
  });

  it("requires seeds for governance benchmark batch mode", () => {
    const action = resolveCliAction(["governance-benchmark", "batch"]);
    expect(action.kind).toBe("error");
  });

  it("requires a source for governance benchmark demo bundle export mode", () => {
    const action = resolveCliAction(["governance-benchmark", "export-bundles"]);
    expect(action.kind).toBe("error");
  });

  it("requires suite and predictions for promotion benchmark scoring mode", () => {
    const action = resolveCliAction(["governance-benchmark", "score-promotion", "--suite", "suite.json"]);
    expect(action.kind).toBe("error");
  });

  it("requires a recipe for promotion benchmark build mode", () => {
    expect(resolveCliAction(["governance-benchmark", "build-promotion"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--recipe")
    });
  });

  it("requires source, recipe, and output paths for promotion source projection", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "project-promotion-source",
      "--source-root", "inputs/raw-source"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--recipe")
    });
  });

  it("requires exactly two source-normalization annotations", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "normalize-promotion-source",
      "--source-root", "outputs/projected-source",
      "--map", "private-map.json",
      "--annotations", "labels-a.jsonl",
      "--out-dir", "outputs/normalized-source"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("exactly two --annotations")
    });
  });

  it("requires a manifest for confirmatory promotion intake freezing", () => {
    expect(resolveCliAction(["governance-benchmark", "freeze-promotion-confirmatory"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--manifest")
    });
  });

  it("requires a manifest for confirmatory promotion intake auditing", () => {
    expect(resolveCliAction(["governance-benchmark", "audit-promotion-confirmatory"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--manifest")
    });
  });

  it("requires a suite and validates systems for promotion benchmark runs", () => {
    expect(resolveCliAction(["governance-benchmark", "run-promotion"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--suite")
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "run-promotion",
      "--suite",
      "suite.json",
      "--system",
      "unknown-system"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("unknown-system")
    });
  });

  it("requires complete promotion provider adapter arguments", () => {
    expect(resolveCliAction(["governance-benchmark", "export-promotion-prompts"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--suite")
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "import-promotion-responses",
      "--map",
      "private-map.json"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--responses")
    });
  });

  it("requires a suite and exactly two annotation files for adjudication", () => {
    expect(resolveCliAction(["governance-benchmark", "export-promotion-annotations"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--suite")
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "adjudicate-promotion",
      "--suite",
      "suite.json",
      "--map",
      "private-map.json",
      "--annotations",
      "labels-a.jsonl"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("exactly two")
    });
  });

  it("requires a suite and exactly two mutation audit files for mutation verification", () => {
    expect(resolveCliAction(["governance-benchmark", "export-promotion-mutation-audit"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--suite")
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "verify-promotion-mutations",
      "--suite",
      "suite.json",
      "--map",
      "private-map.json",
      "--audits",
      "audit-a.jsonl"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("exactly two")
    });
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
