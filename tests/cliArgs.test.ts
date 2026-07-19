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
      "reference-review", "import", "--packet", "packet", "--review", "review.json"
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
      "--freeze-manifest",
      "benchmarks/promotion/frozen-intake-manifest.json",
      "--out-dir",
      "outputs/promotion-suite"
    ])).toEqual({
      kind: "governance-benchmark-build-promotion",
      recipePath: "benchmarks/promotion/recipe.json",
      freezeManifestPath: "benchmarks/promotion/frozen-intake-manifest.json",
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

  it("supports an explicit synthetic promotion development scale", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "generate-promotion-development",
      "--base-count",
      "72",
      "--out-dir",
      "outputs/development-scale-check"
    ])).toEqual({
      kind: "governance-benchmark-generate-promotion-development",
      outDir: "outputs/development-scale-check",
      baseBundleCount: 72
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "generate-promotion-development",
      "--base-count",
      "0"
    ])).toEqual({
      kind: "error",
      message: "--base-count must be a positive integer."
    });
  });

  it("supports cross-verified promotion development evidence export", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "export-promotion-development-evidence",
      "--corpus-manifest",
      "inputs/corpus-manifest.json",
      "--suite",
      "inputs/suite.json",
      "--predictions",
      "runs/predictions.jsonl",
      "--system-run-manifest",
      "runs/system-run-manifest.json",
      "--score",
      "gate/score/promotion-score.json",
      "--gate",
      "gate/promotion-confirmatory-gate.json",
      "--recommendations",
      "gate/review/node-strengthening-recommendations.json",
      "--output",
      "evidence/development-evidence.json"
    ])).toEqual({
      kind: "governance-benchmark-export-promotion-development-evidence",
      corpusManifestPath: "inputs/corpus-manifest.json",
      suitePath: "inputs/suite.json",
      predictionsPath: "runs/predictions.jsonl",
      systemRunManifestPath: "runs/system-run-manifest.json",
      scoreReportPath: "gate/score/promotion-score.json",
      gateReportPath: "gate/promotion-confirmatory-gate.json",
      recommendationsPath: "gate/review/node-strengthening-recommendations.json",
      outputPath: "evidence/development-evidence.json"
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

  it("supports artifact-backed confirmatory promotion gating", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "gate-promotion-confirmatory",
      "--suite",
      "inputs/suite.json",
      "--predictions",
      "inputs/non-provider-predictions.jsonl",
      "--system-run-manifest",
      "runs/deterministic/system-run-manifest.json",
      "--provider-run-manifest",
      "runs/trial-a/provider-run-manifest.json",
      "--provider-run-manifest",
      "runs/trial-b/provider-run-manifest.json",
      "--provider-run-manifest",
      "runs/trial-c/provider-run-manifest.json",
      "--recovery-manifest",
      "inputs/recovery-manifest.json",
      "--ungated-system",
      "ungated",
      "--checklist-system",
      "checklist",
      "--manuscript-system",
      "manuscript",
      "--full-system",
      "full-policy",
      "--ablation-system",
      "policy-ablation",
      "--out-dir",
      "outputs/confirmatory-gate"
    ])).toEqual({
      kind: "governance-benchmark-gate-promotion-confirmatory",
      suitePath: "inputs/suite.json",
      predictionsPath: "inputs/non-provider-predictions.jsonl",
      systemRunManifestPath: "runs/deterministic/system-run-manifest.json",
      providerRunManifestPaths: [
        "runs/trial-a/provider-run-manifest.json",
        "runs/trial-b/provider-run-manifest.json",
        "runs/trial-c/provider-run-manifest.json"
      ],
      recoveryManifestPath: "inputs/recovery-manifest.json",
      systemRoles: {
        ungated: "ungated",
        checklist: "checklist",
        manuscript: "manuscript",
        full: "full-policy",
        ablations: ["policy-ablation"]
      },
      outDir: "outputs/confirmatory-gate"
    });
  });

  it("supports explicit post-repair promotion evaluation", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "evaluate-promotion-recovery",
      "--manifest",
      "inputs/recovery-manifest.json",
      "--out-dir",
      "outputs/recovery"
    ])).toEqual({
      kind: "governance-benchmark-evaluate-promotion-recovery",
      manifestPath: "inputs/recovery-manifest.json",
      outDir: "outputs/recovery"
    });
  });

  it("supports end-to-end synthetic development recovery", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "run-promotion-development-recovery",
      "--suite",
      "inputs/suite.json",
      "--predictions",
      "runs/original/predictions.jsonl",
      "--system-run-manifest",
      "runs/original/system-run-manifest.json",
      "--repaired-suite-id",
      "repaired-development-suite",
      "--repaired-trial-id",
      "post-repair-trial",
      "--out-dir",
      "outputs/development-recovery"
    ])).toEqual({
      kind: "governance-benchmark-run-promotion-development-recovery",
      suitePath: "inputs/suite.json",
      predictionsPath: "runs/original/predictions.jsonl",
      systemRunManifestPath: "runs/original/system-run-manifest.json",
      repairedSuiteId: "repaired-development-suite",
      repairedTrialId: "post-repair-trial",
      outDir: "outputs/development-recovery"
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "run-promotion-development-recovery",
      "--suite",
      "inputs/suite.json"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("requires")
    });
  });

  it("requires a recovery manifest for post-repair evaluation", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "evaluate-promotion-recovery"
    ])).toEqual({
      kind: "error",
      message: "Missing required argument: --manifest <recovery-manifest.json>."
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

  it("supports an explicit fresh promotion provider run", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "run-promotion-provider",
      "--suite", "outputs/promotion-suite/suite.json",
      "--provider", "openai",
      "--model", "gpt-5.4",
      "--reasoning", "high",
      "--system", "manuscript-reviewer",
      "--trial", "trial-beta",
      "--out-dir", "outputs/provider-runs/trial-beta"
    ])).toEqual({
      kind: "governance-benchmark-run-promotion-provider",
      suitePath: "outputs/promotion-suite/suite.json",
      provider: "openai",
      model: "gpt-5.4",
      reasoningEffort: "high",
      systemId: "manuscript-reviewer",
      trialId: "trial-beta",
      outDir: "outputs/provider-runs/trial-beta",
      baseUrl: undefined
    });
  });

  it("supports a hash-bound local model promotion run", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "run-promotion-provider",
      "--suite", "outputs/promotion-suite/suite.json",
      "--provider", "ollama",
      "--model", "local-model:latest",
      "--reasoning", "off",
      "--system", "manuscript-reviewer",
      "--trial", "trial-local",
      "--base-url", "http://127.0.0.1:11434",
      "--out-dir", "outputs/provider-runs/trial-local"
    ])).toEqual({
      kind: "governance-benchmark-run-promotion-provider",
      suitePath: "outputs/promotion-suite/suite.json",
      provider: "ollama",
      model: "local-model:latest",
      reasoningEffort: "off",
      systemId: "manuscript-reviewer",
      trialId: "trial-local",
      outDir: "outputs/provider-runs/trial-local",
      baseUrl: "http://127.0.0.1:11434"
    });
  });

  it("supports aggregating exactly three fresh promotion provider runs", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "aggregate-promotion-provider-runs",
      "--suite", "outputs/promotion-suite/suite.json",
      "--run-manifest", "outputs/provider-runs/trial-a/provider-run-manifest.json",
      "--run-manifest", "outputs/provider-runs/trial-b/provider-run-manifest.json",
      "--run-manifest", "outputs/provider-runs/trial-c/provider-run-manifest.json",
      "--out-dir", "outputs/provider-runs/aggregate"
    ])).toEqual({
      kind: "governance-benchmark-aggregate-promotion-provider-runs",
      suitePath: "outputs/promotion-suite/suite.json",
      runManifestPaths: [
        "outputs/provider-runs/trial-a/provider-run-manifest.json",
        "outputs/provider-runs/trial-b/provider-run-manifest.json",
        "outputs/provider-runs/trial-c/provider-run-manifest.json"
      ],
      outDir: "outputs/provider-runs/aggregate"
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

  it("supports promotion source-expansion audit", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "audit-promotion-source-expansion",
      "--inventory", "inputs/source-expansion.json",
      "--out-dir", "outputs/source-expansion-audit"
    ])).toEqual({
      kind: "governance-benchmark-audit-promotion-source-expansion",
      inventoryPath: "inputs/source-expansion.json",
      outDir: "outputs/source-expansion-audit"
    });
  });

  it("supports revision-bound promotion trial-candidate handoff export", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "export-promotion-trial-candidates",
      "--recipe", "inputs/trial-candidate-source.json",
      "--source-root", "inputs/pinned-source",
      "--out-dir", "outputs/trial-candidate-handoff"
    ])).toEqual({
      kind: "governance-benchmark-export-promotion-trial-candidates",
      recipePath: "inputs/trial-candidate-source.json",
      sourceRoot: "inputs/pinned-source",
      outDir: "outputs/trial-candidate-handoff"
    });
  });

  it("supports isolated pending human-review campaign preparation", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "prepare-promotion-trial-candidate-review-campaign",
      "--handoff-root", "outputs/candidate-handoff",
      "--annotator-id", "reviewer-alpha",
      "--annotator-id", "reviewer-beta",
      "--license-reviewer-id", "license-reviewer",
      "--out-dir", "outputs/review-campaign"
    ])).toEqual({
      kind: "governance-benchmark-prepare-promotion-trial-candidate-review-campaign",
      handoffRoot: "outputs/candidate-handoff",
      annotatorIds: ["reviewer-alpha", "reviewer-beta"],
      licenseReviewerId: "license-reviewer",
      outDir: "outputs/review-campaign"
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "prepare-promotion-trial-candidate-review-campaign",
      "--handoff-root", "outputs/candidate-handoff",
      "--annotator-id", "reviewer-alpha",
      "--license-reviewer-id", "license-reviewer",
      "--out-dir", "outputs/review-campaign"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("exactly two --annotator-id")
    });
  });

  it("supports assignment-bound human-review campaign return collection", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "collect-promotion-trial-candidate-review-campaign",
      "--campaign-root", "outputs/review-campaign",
      "--handoff-root", "outputs/candidate-handoff",
      "--annotation", "returns/review-alpha.json",
      "--annotation", "returns/review-beta.json",
      "--license-review", "returns/license-review.json",
      "--resolution", "returns/resolution.json",
      "--out-dir", "outputs/campaign-return"
    ])).toEqual({
      kind: "governance-benchmark-collect-promotion-trial-candidate-review-campaign",
      campaignRoot: "outputs/review-campaign",
      handoffRoot: "outputs/candidate-handoff",
      annotationPaths: ["returns/review-alpha.json", "returns/review-beta.json"],
      licenseReviewPath: "returns/license-review.json",
      resolutionPath: "returns/resolution.json",
      outDir: "outputs/campaign-return"
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "collect-promotion-trial-candidate-review-campaign",
      "--campaign-root", "outputs/review-campaign",
      "--handoff-root", "outputs/candidate-handoff",
      "--annotation", "returns/review-alpha.json",
      "--license-review", "returns/license-review.json",
      "--out-dir", "outputs/campaign-return"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("exactly two --annotation")
    });
  });

  it("supports unlabeled trial-candidate annotation worksheet preparation", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "prepare-promotion-trial-candidate-worksheet",
      "--handoff-root", "outputs/candidate-handoff",
      "--annotator-id", "reviewer-alpha",
      "--output", "reviews/review-a.json"
    ])).toEqual({
      kind: "governance-benchmark-prepare-promotion-trial-candidate-worksheet",
      handoffRoot: "outputs/candidate-handoff",
      annotatorId: "reviewer-alpha",
      outputPath: "reviews/review-a.json"
    });
  });

  it("supports unreviewed trial-candidate source-license worksheet preparation", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "prepare-promotion-trial-candidate-license-worksheet",
      "--handoff-root", "outputs/candidate-handoff",
      "--reviewer-id", "license-reviewer-alpha",
      "--output", "reviews/license-review.json"
    ])).toEqual({
      kind: "governance-benchmark-prepare-promotion-trial-candidate-license-worksheet",
      handoffRoot: "outputs/candidate-handoff",
      reviewerId: "license-reviewer-alpha",
      outputPath: "reviews/license-review.json"
    });
  });

  it("supports isolated trial-candidate source-license review preflight", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "preflight-promotion-trial-candidate-license-review",
      "--license-root", "outputs/candidate-handoff/license",
      "--review", "reviews/license-review.json",
      "--out-dir", "reviews/license-preflight"
    ])).toEqual({
      kind: "governance-benchmark-preflight-promotion-trial-candidate-license-review",
      licenseRoot: "outputs/candidate-handoff/license",
      reviewPath: "reviews/license-review.json",
      outDir: "reviews/license-preflight"
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "preflight-promotion-trial-candidate-license-review",
      "--handoff-root", "outputs/candidate-handoff",
      "--review", "reviews/license-review.json",
      "--out-dir", "reviews/license-preflight"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Unsupported")
    });
  });

  it("supports trial-candidate human annotation preflight and adjudication", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "preflight-promotion-trial-candidate-annotation",
      "--reviewer-root", "outputs/trial-candidate-handoff/reviewer",
      "--annotation", "inputs/review-a.json",
      "--out-dir", "outputs/review-a-preflight"
    ])).toEqual({
      kind: "governance-benchmark-preflight-promotion-trial-candidate-annotation",
      reviewerRoot: "outputs/trial-candidate-handoff/reviewer",
      annotationPath: "inputs/review-a.json",
      outDir: "outputs/review-a-preflight"
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "preflight-promotion-trial-candidate-annotation",
      "--handoff-root", "outputs/trial-candidate-handoff",
      "--annotation", "inputs/review-a.json",
      "--out-dir", "outputs/review-a-preflight"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Unsupported")
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "adjudicate-promotion-trial-candidate-review",
      "--handoff-root", "outputs/trial-candidate-handoff",
      "--annotation", "inputs/review-a.json",
      "--annotation", "inputs/review-b.json",
      "--license-review", "inputs/license-review.json",
      "--resolution", "inputs/resolution.json",
      "--out-dir", "outputs/review-adjudication"
    ])).toEqual({
      kind: "governance-benchmark-adjudicate-promotion-trial-candidate-review",
      handoffRoot: "outputs/trial-candidate-handoff",
      annotationPaths: ["inputs/review-a.json", "inputs/review-b.json"],
      licenseReviewPath: "inputs/license-review.json",
      resolutionPath: "inputs/resolution.json",
      outDir: "outputs/review-adjudication"
    });
  });

  it("supports fail-closed canonical curation handoff preparation", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "prepare-promotion-canonical-curation",
      "--handoff-root", "outputs/candidate-handoff",
      "--campaign-return-root", "outputs/review-campaign-return",
      "--curator-id", "curator-alpha",
      "--verifier-id", "verifier-beta",
      "--curator-protocol", "curation-protocol-1",
      "--verifier-protocol", "verification-protocol-1",
      "--out-dir", "outputs/curation-handoff"
    ])).toEqual({
      kind: "governance-benchmark-prepare-promotion-canonical-curation",
      handoffRoot: "outputs/candidate-handoff",
      campaignReturnRoot: "outputs/review-campaign-return",
      curatorId: "curator-alpha",
      verifierId: "verifier-beta",
      curatorProtocolVersion: "curation-protocol-1",
      verifierProtocolVersion: "verification-protocol-1",
      outDir: "outputs/curation-handoff"
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "prepare-promotion-canonical-curation",
      "--handoff-root", "outputs/candidate-handoff",
      "--campaign-return-root", "outputs/review-campaign-return",
      "--curator-id", "curator-alpha",
      "--verifier-id", "verifier-beta",
      "--out-dir", "outputs/curation-handoff"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--curator-protocol")
    });
  });

  it("supports assignment-bound canonical curation return collection", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "collect-promotion-canonical-curation",
      "--curation-handoff-root", "outputs/curation-handoff",
      "--source-root", "returns/canonical-source-a",
      "--source-root", "returns/canonical-source-b",
      "--out-dir", "outputs/curation-return"
    ])).toEqual({
      kind: "governance-benchmark-collect-promotion-canonical-curation",
      curationHandoffRoot: "outputs/curation-handoff",
      sourceRoots: [
        "returns/canonical-source-a",
        "returns/canonical-source-b"
      ],
      outDir: "outputs/curation-return"
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "collect-promotion-canonical-curation",
      "--curation-handoff-root", "outputs/curation-handoff",
      "--out-dir", "outputs/curation-return"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("at least one --source-root")
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
      "export-promotion-source-normalization-batch",
      "--recipe", "inputs/source-normalization-batch.json",
      "--out-dir", "outputs/source-normalization-review-batch"
    ])).toEqual({
      kind: "governance-benchmark-export-promotion-source-normalization-batch",
      recipePath: "inputs/source-normalization-batch.json",
      outDir: "outputs/source-normalization-review-batch"
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "preflight-promotion-source-normalization-annotation",
      "--reviewer-root", "outputs/source-normalization-review-batch/reviewer",
      "--annotation", "labels-a.jsonl",
      "--out-dir", "outputs/source-normalization-preflight-a"
    ])).toEqual({
      kind: "governance-benchmark-preflight-promotion-source-normalization-annotation",
      reviewerRoot: "outputs/source-normalization-review-batch/reviewer",
      annotationPath: "labels-a.jsonl",
      outDir: "outputs/source-normalization-preflight-a"
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "adjudicate-promotion-source-normalization-batch",
      "--batch-root", "outputs/source-normalization-review-batch",
      "--annotations", "labels-a.jsonl",
      "--annotations", "labels-b.jsonl",
      "--resolution", "labels-resolution.jsonl",
      "--out-dir", "outputs/source-normalization-adjudication"
    ])).toEqual({
      kind: "governance-benchmark-adjudicate-promotion-source-normalization-batch",
      batchRoot: "outputs/source-normalization-review-batch",
      annotationPaths: ["labels-a.jsonl", "labels-b.jsonl"],
      resolutionPath: "labels-resolution.jsonl",
      outDir: "outputs/source-normalization-adjudication"
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "materialize-promotion-source-normalization-batch",
      "--adjudication-root", "outputs/source-normalization-adjudication",
      "--out-dir", "outputs/source-normalization-materialization"
    ])).toEqual({
      kind: "governance-benchmark-materialize-promotion-source-normalization-batch",
      adjudicationRoot: "outputs/source-normalization-adjudication",
      outDir: "outputs/source-normalization-materialization"
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

  it("requires a portable recipe, local source, and output path for trial-candidate export", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "export-promotion-trial-candidates",
      "--recipe", "inputs/trial-candidate-source.json"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--source-root")
    });
  });

  it("requires exactly two initial trial-candidate reviews and a separate license review", () => {
    expect(resolveCliAction([
      "governance-benchmark",
      "adjudicate-promotion-trial-candidate-review",
      "--handoff-root", "outputs/trial-candidate-handoff",
      "--annotation", "inputs/review-a.json",
      "--out-dir", "outputs/review-adjudication"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("exactly two --annotation")
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "adjudicate-promotion-trial-candidate-review",
      "--handoff-root", "outputs/trial-candidate-handoff",
      "--annotation", "inputs/review-a.json",
      "--annotation", "inputs/review-b.json",
      "--out-dir", "outputs/review-adjudication"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--license-review")
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
    expect(resolveCliAction([
      "governance-benchmark",
      "preflight-promotion-source-normalization-annotation",
      "--reviewer-root", "outputs/source-normalization-review-batch/reviewer",
      "--annotation", "labels-a.jsonl"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--out-dir")
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
    expect(resolveCliAction([
      "governance-benchmark",
      "run-promotion-provider",
      "--suite", "suite.json"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--provider")
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "run-promotion-provider",
      "--suite", "suite.json",
      "--provider", "openai",
      "--model", "unsupported-model",
      "--reasoning", "high",
      "--system", "manuscript-reviewer",
      "--trial", "trial-alpha",
      "--out-dir", "outputs/provider-run"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Unsupported OpenAI Responses model")
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "run-promotion-provider",
      "--suite", "suite.json",
      "--provider", "ollama",
      "--model", "local-model:latest",
      "--reasoning", "high",
      "--system", "manuscript-reviewer",
      "--trial", "trial-alpha",
      "--out-dir", "outputs/provider-run"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--reasoning off")
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "run-promotion-provider",
      "--suite", "suite.json",
      "--provider", "openai",
      "--model", "gpt-5.4",
      "--reasoning", "high",
      "--system", "manuscript-reviewer",
      "--trial", "trial-alpha",
      "--base-url", "http://127.0.0.1:11434",
      "--out-dir", "outputs/provider-run"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("--base-url")
    });
    expect(resolveCliAction([
      "governance-benchmark",
      "aggregate-promotion-provider-runs",
      "--suite", "suite.json",
      "--run-manifest", "trial-a/provider-run-manifest.json",
      "--run-manifest", "trial-b/provider-run-manifest.json",
      "--out-dir", "outputs/aggregate"
    ])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("exactly three --run-manifest")
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
