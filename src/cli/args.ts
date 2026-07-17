import { GovernanceBenchmarkConditionName } from "../core/benchmark/governanceCondition.js";
import type { MetaHarnessNode } from "../core/metaHarness/metaHarness.js";
import {
  PROMOTION_BENCHMARK_SYSTEMS,
  type PromotionBenchmarkSystemName
} from "../core/benchmark/promotionBenchmarkSystems.js";
import {
  PROMOTION_EXECUTION_BACKENDS,
  PROMOTION_EXECUTION_EVIDENCE_ROLES,
  type PromotionExecutionBackend,
  type PromotionExecutionEvidenceRole
} from "../core/benchmark/promotionBenchmarkExecutionEvidence.js";
import {
  buildOpenAiResponsesModelChoices,
  buildOpenAiResponsesReasoningChoices
} from "../integrations/openai/modelCatalog.js";
import { NodeOptionPackageName } from "../types.js";

const META_HARNESS_CLI_NODES = [
  "generate_hypotheses",
  "design_experiments",
  "analyze_results",
  "review"
] as const satisfies readonly MetaHarnessNode[];

export type CliAction =
  | { kind: "run"; packageName?: NodeOptionPackageName; benchmarkCondition?: GovernanceBenchmarkConditionName }
  | { kind: "web"; host?: string; port?: number; benchmarkCondition?: GovernanceBenchmarkConditionName }
  | { kind: "compare-analysis"; runId: string; limit: number; judge: boolean }
  | { kind: "eval-harness"; runIds: string[]; limit: number; outputPath?: string; noHistory?: boolean }
  | { kind: "evolve"; maxCycles: number; target: "skills" | "prompts" | "all"; dryRun: boolean }
  | { kind: "governance-benchmark-seed"; sourcePath: string; taskId?: string; outDir?: string; referenceOnly: boolean }
  | { kind: "governance-benchmark-dry-run"; seedPath: string; taskId?: string; outDir?: string; conditions: GovernanceBenchmarkConditionName[] }
  | { kind: "governance-benchmark-batch"; seedsRoot: string; taskIds: string[]; outDir?: string; conditions: GovernanceBenchmarkConditionName[] }
  | { kind: "governance-benchmark-export-bundles"; publicOutputRoots: string[]; outDir?: string; maxBundles?: number }
  | { kind: "governance-benchmark-build-promotion"; recipePath: string; outDir: string }
  | { kind: "governance-benchmark-run-promotion"; suitePath: string; systems: PromotionBenchmarkSystemName[]; trialId?: string; outDir?: string }
  | { kind: "governance-benchmark-run-promotion-provider"; suitePath: string; provider: "openai"; model: string; reasoningEffort: string; systemId: string; trialId: string; outDir: string }
  | { kind: "governance-benchmark-aggregate-promotion-provider-runs"; suitePath: string; runManifestPaths: string[]; outDir: string }
  | { kind: "governance-benchmark-export-promotion-prompts"; suitePath: string; outDir: string }
  | { kind: "governance-benchmark-import-promotion-responses"; requestMapPath: string; responsesPath: string; systemId: string; trialId: string; outDir: string }
  | { kind: "governance-benchmark-export-promotion-annotations"; suitePath: string; outDir: string }
  | { kind: "governance-benchmark-export-promotion-mutation-audit"; suitePath: string; outDir: string }
  | { kind: "governance-benchmark-verify-promotion-mutations"; suitePath: string; privateMapPath: string; auditPaths: string[]; outDir: string }
  | { kind: "governance-benchmark-adjudicate-promotion"; suitePath: string; privateMapPath: string; annotationPaths: string[]; resolutionPath?: string; mutationAuditReportPath?: string; outDir: string }
  | { kind: "governance-benchmark-generate-promotion-development"; outDir: string }
  | { kind: "governance-benchmark-audit-promotion-source-expansion"; inventoryPath: string; outDir: string }
  | { kind: "governance-benchmark-export-promotion-trial-candidates"; recipePath: string; outDir: string }
  | { kind: "governance-benchmark-prepare-promotion-trial-candidate-worksheet"; handoffRoot: string; annotatorId: string; outputPath: string }
  | { kind: "governance-benchmark-preflight-promotion-trial-candidate-annotation"; handoffRoot: string; annotationPath: string; outDir: string }
  | { kind: "governance-benchmark-adjudicate-promotion-trial-candidate-review"; handoffRoot: string; annotationPaths: string[]; licenseReviewPath: string; resolutionPath?: string; outDir: string }
  | { kind: "governance-benchmark-project-promotion-source"; sourceRoot: string; recipePath: string; outDir: string }
  | { kind: "governance-benchmark-export-promotion-source-normalization"; sourceRoot: string; outDir: string }
  | { kind: "governance-benchmark-export-promotion-source-normalization-batch"; recipePath: string; outDir: string }
  | { kind: "governance-benchmark-preflight-promotion-source-normalization-annotation"; reviewerRoot: string; annotationPath: string; outDir: string }
  | { kind: "governance-benchmark-adjudicate-promotion-source-normalization-batch"; batchRoot: string; annotationPaths: string[]; resolutionPath?: string; outDir: string }
  | { kind: "governance-benchmark-materialize-promotion-source-normalization-batch"; adjudicationRoot: string; outDir: string }
  | { kind: "governance-benchmark-normalize-promotion-source"; sourceRoot: string; privateMapPath: string; annotationPaths: string[]; resolutionPath?: string; outDir: string }
  | { kind: "governance-benchmark-prepare-promotion-execution-evidence"; sourceRoot: string; runId: string; executionBackend: PromotionExecutionBackend; startedAt: string; completedAt: string; trialIds: string[]; artifacts: Array<{ role: PromotionExecutionEvidenceRole; path: string }> }
  | { kind: "governance-benchmark-audit-promotion-confirmatory"; manifestPath: string; outDir: string }
  | { kind: "governance-benchmark-freeze-promotion-confirmatory"; manifestPath: string; outDir: string }
  | { kind: "governance-benchmark-gate-promotion-confirmatory"; suitePath: string; predictionsPath: string; systemRunManifestPath?: string; providerRunManifestPaths: string[]; recoveryManifestPath?: string; systemRoles: { ungated: string; checklist: string; manuscript: string; full: string; ablations: string[] }; outDir: string }
  | { kind: "governance-benchmark-export-promotion-development-evidence"; corpusManifestPath: string; suitePath: string; predictionsPath: string; systemRunManifestPath: string; scoreReportPath: string; gateReportPath: string; recommendationsPath: string; outputPath: string }
  | { kind: "governance-benchmark-analyze-promotion-failures"; suitePath: string; predictionsPath: string; systemId: string; outDir: string }
  | { kind: "governance-benchmark-score-promotion"; suitePath: string; predictionsPath: string; outDir?: string }
  | { kind: "audit"; runRoot?: string; externalRoot?: string; draftPath?: string; logPath?: string; outDir?: string }
  | { kind: "audit-help" }
  | { kind: "research-new"; briefPath: string; outDir?: string }
  | { kind: "research-audit"; runRoot?: string; externalRoot?: string; draftPath?: string; logPath?: string; outDir?: string }
  | { kind: "research-review"; gatePath: string; outDir?: string }
  | { kind: "research-improve"; reviewPath: string; outDir?: string }
  | { kind: "research-pack"; gatePath: string; reviewPath: string; sourceDir?: string; outDir?: string }
  | { kind: "research-help" }
  | {
      kind: "meta-harness";
      runs: number;
      nodes: MetaHarnessNode[];
      externalRunRoots: string[];
      noApply: boolean;
      dryRun: boolean;
    }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

export function resolveCliAction(args: string[]): CliAction {
  if (args.length === 0) {
    return { kind: "run" };
  }

  const packageParse = parseRunPackageArgs(args);
  if (packageParse) {
    return packageParse;
  }

  const first = args[0];
  if (first === "--help" || first === "-h") {
    return { kind: "help" };
  }

  if (first === "--version" || first === "-v") {
    return { kind: "version" };
  }

  if (first === "research") {
    return parseResearchArgs(args.slice(1));
  }

  if (first === "web") {
    let host: string | undefined;
    let port: number | undefined;
    let benchmarkCondition: GovernanceBenchmarkConditionName | undefined;
    for (let index = 1; index < args.length; index += 1) {
      const token = args[index];
      if (token === "--host") {
        const value = args[index + 1];
        if (!value) {
          return { kind: "error", message: "Missing value for --host." };
        }
        host = value;
        index += 1;
        continue;
      }
      if (token === "--port") {
        const value = args[index + 1];
        if (!value) {
          return { kind: "error", message: "Missing value for --port." };
        }
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return { kind: "error", message: `Invalid port: ${value}` };
        }
        port = Math.floor(parsed);
        index += 1;
        continue;
      }
      if (token === "--benchmark-condition") {
        const value = args[index + 1];
        if (!value) {
          return { kind: "error", message: "Missing value for --benchmark-condition." };
        }
        benchmarkCondition = parseGovernanceBenchmarkCondition(value);
        if (!benchmarkCondition) {
          return { kind: "error", message: `Unsupported governance benchmark condition: ${value}.` };
        }
        index += 1;
        continue;
      }
      return {
        kind: "error",
        message: `Unsupported web argument: ${token}`
      };
    }
    return {
      kind: "web",
      ...(host ? { host } : {}),
      ...(port ? { port } : {}),
      ...(benchmarkCondition ? { benchmarkCondition } : {})
    };
  }

  if (first === "compare-analysis") {
    let runId: string | undefined;
    let limit = 3;
    let judge = true;
    for (let index = 1; index < args.length; index += 1) {
      const token = args[index];
      if (token === "--run") {
        const value = args[index + 1];
        if (!value) {
          return { kind: "error", message: "Missing value for --run." };
        }
        runId = value;
        index += 1;
        continue;
      }
      if (token === "--limit") {
        const value = args[index + 1];
        if (!value) {
          return { kind: "error", message: "Missing value for --limit." };
        }
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return { kind: "error", message: `Invalid limit: ${value}` };
        }
        limit = Math.floor(parsed);
        index += 1;
        continue;
      }
      if (token === "--no-judge") {
        judge = false;
        continue;
      }
      return {
        kind: "error",
        message: `Unsupported compare-analysis argument: ${token}`
      };
    }
    if (!runId) {
      return { kind: "error", message: "Missing required argument: --run <run-id>." };
    }
    return { kind: "compare-analysis", runId, limit, judge };
  }

  if (first === "eval-harness") {
    const runIds: string[] = [];
    let limit = 10;
    let outputPath: string | undefined;
    let noHistory = false;
    for (let index = 1; index < args.length; index += 1) {
      const token = args[index];
      if (token === "--run") {
        const value = args[index + 1];
        if (!value) {
          return { kind: "error", message: "Missing value for --run." };
        }
        runIds.push(value);
        index += 1;
        continue;
      }
      if (token === "--limit") {
        const value = args[index + 1];
        if (!value) {
          return { kind: "error", message: "Missing value for --limit." };
        }
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return { kind: "error", message: `Invalid limit: ${value}` };
        }
        limit = Math.floor(parsed);
        index += 1;
        continue;
      }
      if (token === "--output") {
        const value = args[index + 1];
        if (!value) {
          return { kind: "error", message: "Missing value for --output." };
        }
        outputPath = value;
        index += 1;
        continue;
      }
      if (token === "--no-history") {
        noHistory = true;
        continue;
      }
      return {
        kind: "error",
        message: `Unsupported eval-harness argument: ${token}`
      };
    }
    return { kind: "eval-harness", runIds, limit, outputPath, noHistory };
  }

  if (first === "evolve") {
    let maxCycles = 3;
    let target: "skills" | "prompts" | "all" = "all";
    let dryRun = false;
    for (let index = 1; index < args.length; index += 1) {
      const token = args[index];
      if (token === "--max-cycles") {
        const value = args[index + 1];
        if (!value) {
          return { kind: "error", message: "Missing value for --max-cycles." };
        }
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return { kind: "error", message: `Invalid max cycle count: ${value}` };
        }
        maxCycles = Math.floor(parsed);
        index += 1;
        continue;
      }
      if (token === "--target") {
        const value = args[index + 1];
        if (!value) {
          return { kind: "error", message: "Missing value for --target." };
        }
        if (value !== "skills" && value !== "prompts" && value !== "all") {
          return {
            kind: "error",
            message: `Unsupported evolve target: ${value}. Expected one of skills, prompts, all.`
          };
        }
        target = value;
        index += 1;
        continue;
      }
      if (token === "--dry-run") {
        dryRun = true;
        continue;
      }
      return {
        kind: "error",
        message: `Unsupported evolve argument: ${token}`
      };
    }
    return { kind: "evolve", maxCycles, target, dryRun };
  }

  if (first === "audit") {
    if (args[1] === "--help" || args[1] === "-h") {
      return { kind: "audit-help" };
    }
    let runRoot: string | undefined;
    let externalRoot: string | undefined;
    let draftPath: string | undefined;
    let logPath: string | undefined;
    let outDir: string | undefined;
    for (let index = 1; index < args.length; index += 1) {
      const token = args[index];
      if (token === "--run") {
        const value = args[index + 1];
        if (!value) {
          return { kind: "error", message: "Missing value for --run." };
        }
        runRoot = value;
        index += 1;
        continue;
      }
      if (token === "--external") {
        const value = args[index + 1];
        if (!value) {
          return { kind: "error", message: "Missing value for --external." };
        }
        externalRoot = value;
        index += 1;
        continue;
      }
      if (token === "--draft") {
        const value = args[index + 1];
        if (!value) {
          return { kind: "error", message: "Missing value for --draft." };
        }
        draftPath = value;
        index += 1;
        continue;
      }
      if (token === "--log") {
        const value = args[index + 1];
        if (!value) {
          return { kind: "error", message: "Missing value for --log." };
        }
        logPath = value;
        index += 1;
        continue;
      }
      if (token === "--out-dir") {
        const value = args[index + 1];
        if (!value) {
          return { kind: "error", message: "Missing value for --out-dir." };
        }
        outDir = value;
        index += 1;
        continue;
      }
      return {
        kind: "error",
        message: `Unsupported audit argument: ${token}`
      };
    }
    if ([runRoot, externalRoot].filter(Boolean).length !== 1) {
      return {
        kind: "error",
        message: "Usage: audit (--run <run-artifact-root> | --external <artifact-root> [--draft <draft.md>] [--log <run.log>]) [--out-dir outputs/audit]."
      };
    }
    if (!externalRoot && (draftPath || logPath)) {
      return { kind: "error", message: "--draft and --log require --external <artifact-root>." };
    }
    return { kind: "audit", runRoot, externalRoot, draftPath, logPath, outDir };
  }

  if (first === "governance-benchmark") {
    const subcommand = args[1];
    if (subcommand !== "seed" && subcommand !== "dry-run" && subcommand !== "batch" && subcommand !== "export-bundles" && subcommand !== "generate-promotion-development" && subcommand !== "export-promotion-development-evidence" && subcommand !== "audit-promotion-source-expansion" && subcommand !== "export-promotion-trial-candidates" && subcommand !== "prepare-promotion-trial-candidate-worksheet" && subcommand !== "preflight-promotion-trial-candidate-annotation" && subcommand !== "adjudicate-promotion-trial-candidate-review" && subcommand !== "project-promotion-source" && subcommand !== "export-promotion-source-normalization" && subcommand !== "export-promotion-source-normalization-batch" && subcommand !== "preflight-promotion-source-normalization-annotation" && subcommand !== "adjudicate-promotion-source-normalization-batch" && subcommand !== "materialize-promotion-source-normalization-batch" && subcommand !== "normalize-promotion-source" && subcommand !== "prepare-promotion-execution-evidence" && subcommand !== "audit-promotion-confirmatory" && subcommand !== "freeze-promotion-confirmatory" && subcommand !== "gate-promotion-confirmatory" && subcommand !== "build-promotion" && subcommand !== "run-promotion" && subcommand !== "run-promotion-provider" && subcommand !== "aggregate-promotion-provider-runs" && subcommand !== "export-promotion-prompts" && subcommand !== "import-promotion-responses" && subcommand !== "export-promotion-annotations" && subcommand !== "export-promotion-mutation-audit" && subcommand !== "verify-promotion-mutations" && subcommand !== "adjudicate-promotion" && subcommand !== "analyze-promotion-failures" && subcommand !== "score-promotion") {
      return {
        kind: "error",
        message:
          "Usage: governance-benchmark seed|dry-run|batch|export-bundles|generate-promotion-development|export-promotion-development-evidence|audit-promotion-source-expansion|export-promotion-trial-candidates|prepare-promotion-trial-candidate-worksheet|preflight-promotion-trial-candidate-annotation|adjudicate-promotion-trial-candidate-review|project-promotion-source|export-promotion-source-normalization|export-promotion-source-normalization-batch|preflight-promotion-source-normalization-annotation|adjudicate-promotion-source-normalization-batch|materialize-promotion-source-normalization-batch|normalize-promotion-source|prepare-promotion-execution-evidence|audit-promotion-confirmatory|freeze-promotion-confirmatory|gate-promotion-confirmatory|build-promotion|run-promotion|run-promotion-provider|aggregate-promotion-provider-runs|export-promotion-prompts|import-promotion-responses|export-promotion-annotations|export-promotion-mutation-audit|verify-promotion-mutations|adjudicate-promotion|analyze-promotion-failures|score-promotion [options]."
      };
    }
    if (subcommand === "audit-promotion-source-expansion") {
      let inventoryPath: string | undefined;
      let outDir: string | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--inventory" && token !== "--out-dir") {
          return { kind: "error", message: `Unsupported governance-benchmark audit-promotion-source-expansion argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { kind: "error", message: `Missing value for ${token}.` };
        if (token === "--inventory") inventoryPath = value;
        else outDir = value;
        index += 1;
      }
      if (!inventoryPath || !outDir) {
        return { kind: "error", message: "Missing required arguments: --inventory and --out-dir are required." };
      }
      return { kind: "governance-benchmark-audit-promotion-source-expansion", inventoryPath, outDir };
    }
    if (subcommand === "export-promotion-trial-candidates") {
      let recipePath: string | undefined;
      let outDir: string | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--recipe" && token !== "--out-dir") {
          return { kind: "error", message: `Unsupported governance-benchmark export-promotion-trial-candidates argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { kind: "error", message: `Missing value for ${token}.` };
        if (token === "--recipe") recipePath = value;
        else outDir = value;
        index += 1;
      }
      if (!recipePath || !outDir) {
        return { kind: "error", message: "Missing required arguments: --recipe and --out-dir are required." };
      }
      return { kind: "governance-benchmark-export-promotion-trial-candidates", recipePath, outDir };
    }
    if (subcommand === "prepare-promotion-trial-candidate-worksheet") {
      let handoffRoot: string | undefined;
      let annotatorId: string | undefined;
      let outputPath: string | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--handoff-root" && token !== "--annotator-id" && token !== "--output") {
          return { kind: "error", message: `Unsupported governance-benchmark prepare-promotion-trial-candidate-worksheet argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { kind: "error", message: `Missing value for ${token}.` };
        if (token === "--handoff-root") handoffRoot = value;
        else if (token === "--annotator-id") annotatorId = value;
        else outputPath = value;
        index += 1;
      }
      if (!handoffRoot || !annotatorId || !outputPath) {
        return { kind: "error", message: "Missing required arguments: --handoff-root, --annotator-id, and --output are required." };
      }
      return {
        kind: "governance-benchmark-prepare-promotion-trial-candidate-worksheet",
        handoffRoot,
        annotatorId,
        outputPath
      };
    }
    if (subcommand === "preflight-promotion-trial-candidate-annotation") {
      let handoffRoot: string | undefined;
      let annotationPath: string | undefined;
      let outDir: string | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--handoff-root" && token !== "--annotation" && token !== "--out-dir") {
          return { kind: "error", message: `Unsupported governance-benchmark preflight-promotion-trial-candidate-annotation argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { kind: "error", message: `Missing value for ${token}.` };
        if (token === "--handoff-root") handoffRoot = value;
        else if (token === "--annotation") annotationPath = value;
        else outDir = value;
        index += 1;
      }
      if (!handoffRoot || !annotationPath || !outDir) {
        return { kind: "error", message: "Missing required arguments: --handoff-root, --annotation, and --out-dir are required." };
      }
      return {
        kind: "governance-benchmark-preflight-promotion-trial-candidate-annotation",
        handoffRoot,
        annotationPath,
        outDir
      };
    }
    if (subcommand === "adjudicate-promotion-trial-candidate-review") {
      let handoffRoot: string | undefined;
      let licenseReviewPath: string | undefined;
      let resolutionPath: string | undefined;
      let outDir: string | undefined;
      const annotationPaths: string[] = [];
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--handoff-root" && token !== "--annotation"
            && token !== "--license-review" && token !== "--resolution" && token !== "--out-dir") {
          return { kind: "error", message: `Unsupported governance-benchmark adjudicate-promotion-trial-candidate-review argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { kind: "error", message: `Missing value for ${token}.` };
        if (token === "--handoff-root") handoffRoot = value;
        else if (token === "--annotation") annotationPaths.push(value);
        else if (token === "--license-review") licenseReviewPath = value;
        else if (token === "--resolution") resolutionPath = value;
        else outDir = value;
        index += 1;
      }
      if (!handoffRoot || annotationPaths.length !== 2 || !licenseReviewPath || !outDir) {
        return { kind: "error", message: "Missing required arguments: --handoff-root, exactly two --annotation values, --license-review, and --out-dir are required." };
      }
      return {
        kind: "governance-benchmark-adjudicate-promotion-trial-candidate-review",
        handoffRoot,
        annotationPaths,
        licenseReviewPath,
        resolutionPath,
        outDir
      };
    }
    if (subcommand === "project-promotion-source") {
      let sourceRoot: string | undefined;
      let recipePath: string | undefined;
      let outDir: string | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--source-root" && token !== "--recipe" && token !== "--out-dir") {
          return { kind: "error", message: `Unsupported governance-benchmark project-promotion-source argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { kind: "error", message: `Missing value for ${token}.` };
        if (token === "--source-root") sourceRoot = value;
        else if (token === "--recipe") recipePath = value;
        else outDir = value;
        index += 1;
      }
      if (!sourceRoot || !recipePath || !outDir) {
        return { kind: "error", message: "Missing required arguments: --source-root, --recipe, and --out-dir are required." };
      }
      return { kind: "governance-benchmark-project-promotion-source", sourceRoot, recipePath, outDir };
    }
    if (subcommand === "export-promotion-source-normalization") {
      let sourceRoot: string | undefined;
      let outDir: string | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--source-root" && token !== "--out-dir") {
          return { kind: "error", message: `Unsupported governance-benchmark export-promotion-source-normalization argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { kind: "error", message: `Missing value for ${token}.` };
        if (token === "--source-root") sourceRoot = value;
        else outDir = value;
        index += 1;
      }
      if (!sourceRoot || !outDir) {
        return { kind: "error", message: "Missing required arguments: --source-root and --out-dir are required." };
      }
      return { kind: "governance-benchmark-export-promotion-source-normalization", sourceRoot, outDir };
    }
    if (subcommand === "export-promotion-source-normalization-batch") {
      let recipePath: string | undefined;
      let outDir: string | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--recipe" && token !== "--out-dir") {
          return { kind: "error", message: `Unsupported governance-benchmark export-promotion-source-normalization-batch argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { kind: "error", message: `Missing value for ${token}.` };
        if (token === "--recipe") recipePath = value;
        else outDir = value;
        index += 1;
      }
      if (!recipePath || !outDir) {
        return { kind: "error", message: "Missing required arguments: --recipe and --out-dir are required." };
      }
      return { kind: "governance-benchmark-export-promotion-source-normalization-batch", recipePath, outDir };
    }
    if (subcommand === "preflight-promotion-source-normalization-annotation") {
      let reviewerRoot: string | undefined;
      let annotationPath: string | undefined;
      let outDir: string | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--reviewer-root" && token !== "--annotation" && token !== "--out-dir") {
          return {
            kind: "error",
            message: `Unsupported governance-benchmark preflight-promotion-source-normalization-annotation argument: ${token}`
          };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { kind: "error", message: `Missing value for ${token}.` };
        if (token === "--reviewer-root") reviewerRoot = value;
        else if (token === "--annotation") annotationPath = value;
        else outDir = value;
        index += 1;
      }
      if (!reviewerRoot || !annotationPath || !outDir) {
        return {
          kind: "error",
          message: "preflight-promotion-source-normalization-annotation requires --reviewer-root, --annotation, and --out-dir."
        };
      }
      return {
        kind: "governance-benchmark-preflight-promotion-source-normalization-annotation",
        reviewerRoot,
        annotationPath,
        outDir
      };
    }
    if (subcommand === "adjudicate-promotion-source-normalization-batch") {
      let batchRoot: string | undefined;
      let resolutionPath: string | undefined;
      let outDir: string | undefined;
      const annotationPaths: string[] = [];
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--batch-root" && token !== "--annotations"
            && token !== "--resolution" && token !== "--out-dir") {
          return { kind: "error", message: `Unsupported governance-benchmark adjudicate-promotion-source-normalization-batch argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { kind: "error", message: `Missing value for ${token}.` };
        if (token === "--batch-root") batchRoot = value;
        else if (token === "--annotations") annotationPaths.push(value);
        else if (token === "--resolution") resolutionPath = value;
        else outDir = value;
        index += 1;
      }
      if (!batchRoot || annotationPaths.length !== 2 || !outDir) {
        return {
          kind: "error",
          message: "Missing required arguments: --batch-root, exactly two --annotations values, and --out-dir are required."
        };
      }
      return {
        kind: "governance-benchmark-adjudicate-promotion-source-normalization-batch",
        batchRoot,
        annotationPaths,
        resolutionPath,
        outDir
      };
    }
    if (subcommand === "materialize-promotion-source-normalization-batch") {
      let adjudicationRoot: string | undefined;
      let outDir: string | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--adjudication-root" && token !== "--out-dir") {
          return { kind: "error", message: `Unsupported governance-benchmark materialize-promotion-source-normalization-batch argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { kind: "error", message: `Missing value for ${token}.` };
        if (token === "--adjudication-root") adjudicationRoot = value;
        else outDir = value;
        index += 1;
      }
      if (!adjudicationRoot || !outDir) {
        return {
          kind: "error",
          message: "Missing required arguments: --adjudication-root and --out-dir are required."
        };
      }
      return {
        kind: "governance-benchmark-materialize-promotion-source-normalization-batch",
        adjudicationRoot,
        outDir
      };
    }
    if (subcommand === "normalize-promotion-source") {
      let sourceRoot: string | undefined;
      let privateMapPath: string | undefined;
      let resolutionPath: string | undefined;
      let outDir: string | undefined;
      const annotationPaths: string[] = [];
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--source-root" && token !== "--map" && token !== "--annotations"
            && token !== "--resolution" && token !== "--out-dir") {
          return { kind: "error", message: `Unsupported governance-benchmark normalize-promotion-source argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { kind: "error", message: `Missing value for ${token}.` };
        if (token === "--source-root") sourceRoot = value;
        else if (token === "--map") privateMapPath = value;
        else if (token === "--annotations") annotationPaths.push(value);
        else if (token === "--resolution") resolutionPath = value;
        else outDir = value;
        index += 1;
      }
      if (!sourceRoot || !privateMapPath || !outDir || annotationPaths.length !== 2) {
        return {
          kind: "error",
          message: "Missing required arguments: --source-root, --map, exactly two --annotations values, and --out-dir are required."
        };
      }
      return {
        kind: "governance-benchmark-normalize-promotion-source",
        sourceRoot,
        privateMapPath,
        annotationPaths,
        resolutionPath,
        outDir
      };
    }
    if (subcommand === "prepare-promotion-execution-evidence") {
      let sourceRoot: string | undefined;
      let runId: string | undefined;
      let executionBackend: PromotionExecutionBackend | undefined;
      let startedAt: string | undefined;
      let completedAt: string | undefined;
      const trialIds: string[] = [];
      const artifacts: Array<{ role: PromotionExecutionEvidenceRole; path: string }> = [];
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (!["--source-root", "--run-id", "--backend", "--started-at", "--completed-at", "--trial", "--artifact"].includes(token)) {
          return { kind: "error", message: `Unsupported governance-benchmark prepare-promotion-execution-evidence argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { kind: "error", message: `Missing value for ${token}.` };
        if (token === "--source-root") sourceRoot = value;
        else if (token === "--run-id") runId = value;
        else if (token === "--backend") {
          if (!(PROMOTION_EXECUTION_BACKENDS as readonly string[]).includes(value)) {
            return { kind: "error", message: `Unsupported execution backend: ${value}.` };
          }
          executionBackend = value as PromotionExecutionBackend;
        } else if (token === "--started-at") startedAt = value;
        else if (token === "--completed-at") completedAt = value;
        else if (token === "--trial") trialIds.push(value);
        else {
          const separator = value.indexOf("=");
          const role = separator > 0 ? value.slice(0, separator) : "";
          const artifactPath = separator > 0 ? value.slice(separator + 1) : "";
          if (!(PROMOTION_EXECUTION_EVIDENCE_ROLES as readonly string[]).includes(role) || !artifactPath) {
            return { kind: "error", message: `Invalid --artifact value: ${value}; expected <role>=<relative-path>.` };
          }
          artifacts.push({ role: role as PromotionExecutionEvidenceRole, path: artifactPath });
        }
        index += 1;
      }
      if (!sourceRoot || !runId || !executionBackend || !startedAt || !completedAt) {
        return {
          kind: "error",
          message: "Missing required arguments: --source-root, --run-id, --backend, --started-at, and --completed-at are required."
        };
      }
      if (trialIds.length < 3) return { kind: "error", message: "At least three --trial values are required." };
      const artifactRoles = new Set(artifacts.map((artifact) => artifact.role));
      if (artifactRoles.size !== artifacts.length) return { kind: "error", message: "Each --artifact role must be supplied exactly once." };
      const missingRoles = PROMOTION_EXECUTION_EVIDENCE_ROLES.filter((role) => !artifactRoles.has(role));
      if (missingRoles.length > 0) {
        return { kind: "error", message: `Missing required --artifact roles: ${missingRoles.join(", ")}.` };
      }
      return {
        kind: "governance-benchmark-prepare-promotion-execution-evidence",
        sourceRoot,
        runId,
        executionBackend,
        startedAt,
        completedAt,
        trialIds,
        artifacts
      };
    }
    if (subcommand === "audit-promotion-confirmatory") {
      let manifestPath: string | undefined;
      let outDir = "outputs/governance-benchmark/promotion-confirmatory-audit";
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--manifest" || token === "--out-dir") {
          const value = args[index + 1];
          if (!value || value.startsWith("--")) return { kind: "error", message: `Missing value for ${token}.` };
          if (token === "--manifest") manifestPath = value;
          else outDir = value;
          index += 1;
          continue;
        }
        return { kind: "error", message: `Unsupported governance-benchmark audit-promotion-confirmatory argument: ${token}` };
      }
      if (!manifestPath) return { kind: "error", message: "Missing required argument: --manifest <intake.json>." };
      return { kind: "governance-benchmark-audit-promotion-confirmatory", manifestPath, outDir };
    }
    if (subcommand === "freeze-promotion-confirmatory") {
      let manifestPath: string | undefined;
      let outDir = "outputs/governance-benchmark/promotion-confirmatory";
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--manifest" || token === "--out-dir") {
          const value = args[index + 1];
          if (!value) return { kind: "error", message: `Missing value for ${token}.` };
          if (token === "--manifest") manifestPath = value;
          else outDir = value;
          index += 1;
          continue;
        }
        return { kind: "error", message: `Unsupported governance-benchmark freeze-promotion-confirmatory argument: ${token}` };
      }
      if (!manifestPath) return { kind: "error", message: "Missing required argument: --manifest <intake.json>." };
      return { kind: "governance-benchmark-freeze-promotion-confirmatory", manifestPath, outDir };
    }
    if (subcommand === "generate-promotion-development") {
      let outDir = "outputs/governance-benchmark/promotion-development-corpus";
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--out-dir") {
          return { kind: "error", message: `Unsupported governance-benchmark generate-promotion-development argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value) return { kind: "error", message: "Missing value for --out-dir." };
        outDir = value;
        index += 1;
      }
      return { kind: "governance-benchmark-generate-promotion-development", outDir };
    }
    if (subcommand === "build-promotion") {
      let recipePath: string | undefined;
      let outDir = "outputs/governance-benchmark/promotion-suite";
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--recipe" || token === "--out-dir") {
          const value = args[index + 1];
          if (!value) return { kind: "error", message: `Missing value for ${token}.` };
          if (token === "--recipe") recipePath = value;
          else outDir = value;
          index += 1;
          continue;
        }
        return { kind: "error", message: `Unsupported governance-benchmark build-promotion argument: ${token}` };
      }
      if (!recipePath) return { kind: "error", message: "Missing required argument: --recipe <recipe.json>." };
      return { kind: "governance-benchmark-build-promotion", recipePath, outDir };
    }
    if (subcommand === "run-promotion") {
      let suitePath: string | undefined;
      let outDir: string | undefined;
      let trialId: string | undefined;
      const systems: PromotionBenchmarkSystemName[] = [];
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--suite" || token === "--system" || token === "--trial" || token === "--out-dir") {
          const value = args[index + 1];
          if (!value) return { kind: "error", message: `Missing value for ${token}.` };
          if (token === "--suite") suitePath = value;
          else if (token === "--system") {
            if (!(PROMOTION_BENCHMARK_SYSTEMS as readonly string[]).includes(value)) {
              return { kind: "error", message: `Unsupported promotion benchmark system: ${value}.` };
            }
            systems.push(value as PromotionBenchmarkSystemName);
          } else if (token === "--trial") trialId = value;
          else outDir = value;
          index += 1;
          continue;
        }
        return { kind: "error", message: `Unsupported governance-benchmark run-promotion argument: ${token}` };
      }
      if (!suitePath) return { kind: "error", message: "Missing required argument: --suite <suite.json>." };
      return { kind: "governance-benchmark-run-promotion", suitePath, systems, trialId, outDir };
    }
    if (subcommand === "run-promotion-provider") {
      let suitePath: string | undefined;
      let provider: "openai" | undefined;
      let model: string | undefined;
      let reasoningEffort: string | undefined;
      let systemId: string | undefined;
      let trialId: string | undefined;
      let outDir: string | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (!["--suite", "--provider", "--model", "--reasoning", "--system", "--trial", "--out-dir"].includes(token)) {
          return { kind: "error", message: `Unsupported governance-benchmark run-promotion-provider argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { kind: "error", message: `Missing value for ${token}.` };
        if (token === "--suite") suitePath = value;
        else if (token === "--provider") {
          if (value !== "openai") return { kind: "error", message: `Unsupported promotion provider: ${value}.` };
          provider = value;
        } else if (token === "--model") model = value;
        else if (token === "--reasoning") reasoningEffort = value;
        else if (token === "--system") systemId = value;
        else if (token === "--trial") trialId = value;
        else outDir = value;
        index += 1;
      }
      if (!suitePath || !provider || !model || !reasoningEffort || !systemId || !trialId || !outDir) {
        return {
          kind: "error",
          message: "run-promotion-provider requires --suite, --provider, --model, --reasoning, --system, --trial, and --out-dir."
        };
      }
      if (!buildOpenAiResponsesModelChoices().includes(model)) {
        return { kind: "error", message: `Unsupported OpenAI Responses model: ${model}.` };
      }
      if (!buildOpenAiResponsesReasoningChoices(model).includes(reasoningEffort)) {
        return { kind: "error", message: `Unsupported reasoning effort for ${model}: ${reasoningEffort}.` };
      }
      return {
        kind: "governance-benchmark-run-promotion-provider",
        suitePath,
        provider,
        model,
        reasoningEffort,
        systemId,
        trialId,
        outDir
      };
    }
    if (subcommand === "aggregate-promotion-provider-runs") {
      let suitePath: string | undefined;
      let outDir: string | undefined;
      const runManifestPaths: string[] = [];
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (!["--suite", "--run-manifest", "--out-dir"].includes(token)) {
          return {
            kind: "error",
            message: `Unsupported governance-benchmark aggregate-promotion-provider-runs argument: ${token}`
          };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { kind: "error", message: `Missing value for ${token}.` };
        if (token === "--suite") suitePath = value;
        else if (token === "--run-manifest") runManifestPaths.push(value);
        else outDir = value;
        index += 1;
      }
      if (!suitePath || !outDir || runManifestPaths.length !== 3) {
        return {
          kind: "error",
          message: "aggregate-promotion-provider-runs requires --suite, exactly three --run-manifest values, and --out-dir."
        };
      }
      return {
        kind: "governance-benchmark-aggregate-promotion-provider-runs",
        suitePath,
        runManifestPaths,
        outDir
      };
    }
    if (subcommand === "export-promotion-prompts") {
      let suitePath: string | undefined;
      let outDir = "outputs/governance-benchmark/promotion-prompts";
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--suite" || token === "--out-dir") {
          const value = args[index + 1];
          if (!value) return { kind: "error", message: `Missing value for ${token}.` };
          if (token === "--suite") suitePath = value;
          else outDir = value;
          index += 1;
          continue;
        }
        return { kind: "error", message: `Unsupported governance-benchmark export-promotion-prompts argument: ${token}` };
      }
      if (!suitePath) return { kind: "error", message: "Missing required argument: --suite <suite.json>." };
      return { kind: "governance-benchmark-export-promotion-prompts", suitePath, outDir };
    }
    if (subcommand === "import-promotion-responses") {
      let requestMapPath: string | undefined;
      let responsesPath: string | undefined;
      let systemId: string | undefined;
      let trialId: string | undefined;
      let outDir = "outputs/governance-benchmark/provider-predictions";
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--map" || token === "--responses" || token === "--system" || token === "--trial" || token === "--out-dir") {
          const value = args[index + 1];
          if (!value) return { kind: "error", message: `Missing value for ${token}.` };
          if (token === "--map") requestMapPath = value;
          else if (token === "--responses") responsesPath = value;
          else if (token === "--system") systemId = value;
          else if (token === "--trial") trialId = value;
          else outDir = value;
          index += 1;
          continue;
        }
        return { kind: "error", message: `Unsupported governance-benchmark import-promotion-responses argument: ${token}` };
      }
      if (!requestMapPath || !responsesPath || !systemId || !trialId) {
        return { kind: "error", message: "Missing required arguments: --map, --responses, --system, and --trial." };
      }
      return {
        kind: "governance-benchmark-import-promotion-responses",
        requestMapPath,
        responsesPath,
        systemId,
        trialId,
        outDir
      };
    }
    if (subcommand === "export-promotion-annotations") {
      let suitePath: string | undefined;
      let outDir = "outputs/governance-benchmark/promotion-annotations";
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--suite" || token === "--out-dir") {
          const value = args[index + 1];
          if (!value) return { kind: "error", message: `Missing value for ${token}.` };
          if (token === "--suite") suitePath = value;
          else outDir = value;
          index += 1;
          continue;
        }
        return { kind: "error", message: `Unsupported governance-benchmark export-promotion-annotations argument: ${token}` };
      }
      if (!suitePath) return { kind: "error", message: "Missing required argument: --suite <suite.json>." };
      return { kind: "governance-benchmark-export-promotion-annotations", suitePath, outDir };
    }
    if (subcommand === "export-promotion-mutation-audit") {
      let suitePath: string | undefined;
      let outDir = "outputs/governance-benchmark/promotion-mutation-audit";
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--suite" || token === "--out-dir") {
          const value = args[index + 1];
          if (!value) return { kind: "error", message: `Missing value for ${token}.` };
          if (token === "--suite") suitePath = value;
          else outDir = value;
          index += 1;
          continue;
        }
        return { kind: "error", message: `Unsupported governance-benchmark export-promotion-mutation-audit argument: ${token}` };
      }
      if (!suitePath) return { kind: "error", message: "Missing required argument: --suite <suite.json>." };
      return { kind: "governance-benchmark-export-promotion-mutation-audit", suitePath, outDir };
    }
    if (subcommand === "verify-promotion-mutations") {
      let suitePath: string | undefined;
      let privateMapPath: string | undefined;
      let outDir = "outputs/governance-benchmark/promotion-mutation-verification";
      const auditPaths: string[] = [];
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--suite" || token === "--map" || token === "--audits" || token === "--out-dir") {
          const value = args[index + 1];
          if (!value) return { kind: "error", message: `Missing value for ${token}.` };
          if (token === "--suite") suitePath = value;
          else if (token === "--map") privateMapPath = value;
          else if (token === "--audits") auditPaths.push(value);
          else outDir = value;
          index += 1;
          continue;
        }
        return { kind: "error", message: `Unsupported governance-benchmark verify-promotion-mutations argument: ${token}` };
      }
      if (!suitePath || !privateMapPath || auditPaths.length !== 2) {
        return { kind: "error", message: "verify-promotion-mutations requires --suite, --map, and exactly two --audits files." };
      }
      return {
        kind: "governance-benchmark-verify-promotion-mutations",
        suitePath,
        privateMapPath,
        auditPaths,
        outDir
      };
    }
    if (subcommand === "adjudicate-promotion") {
      let suitePath: string | undefined;
      let privateMapPath: string | undefined;
      let resolutionPath: string | undefined;
      let mutationAuditReportPath: string | undefined;
      let outDir = "outputs/governance-benchmark/promotion-adjudication";
      const annotationPaths: string[] = [];
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--suite" || token === "--map" || token === "--annotations" || token === "--resolution"
            || token === "--mutation-audit-report" || token === "--out-dir") {
          const value = args[index + 1];
          if (!value) return { kind: "error", message: `Missing value for ${token}.` };
          if (token === "--suite") suitePath = value;
          else if (token === "--map") privateMapPath = value;
          else if (token === "--annotations") annotationPaths.push(value);
          else if (token === "--resolution") resolutionPath = value;
          else if (token === "--mutation-audit-report") mutationAuditReportPath = value;
          else outDir = value;
          index += 1;
          continue;
        }
        return { kind: "error", message: `Unsupported governance-benchmark adjudicate-promotion argument: ${token}` };
      }
      if (!suitePath || !privateMapPath || annotationPaths.length !== 2) {
        return { kind: "error", message: "adjudicate-promotion requires --suite, --map, and exactly two --annotations files." };
      }
      return {
        kind: "governance-benchmark-adjudicate-promotion",
        suitePath,
        privateMapPath,
        annotationPaths,
        resolutionPath,
        mutationAuditReportPath,
        outDir
      };
    }
    if (subcommand === "export-promotion-development-evidence") {
      let corpusManifestPath: string | undefined;
      let suitePath: string | undefined;
      let predictionsPath: string | undefined;
      let systemRunManifestPath: string | undefined;
      let scoreReportPath: string | undefined;
      let gateReportPath: string | undefined;
      let recommendationsPath: string | undefined;
      let outputPath: string | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
          return { kind: "error", message: "Missing value for " + token + "." };
        }
        if (token === "--corpus-manifest") corpusManifestPath = value;
        else if (token === "--suite") suitePath = value;
        else if (token === "--predictions") predictionsPath = value;
        else if (token === "--system-run-manifest") systemRunManifestPath = value;
        else if (token === "--score") scoreReportPath = value;
        else if (token === "--gate") gateReportPath = value;
        else if (token === "--recommendations") recommendationsPath = value;
        else if (token === "--output") outputPath = value;
        else {
          return {
            kind: "error",
            message: "Unsupported governance-benchmark export-promotion-development-evidence argument: " + token
          };
        }
        index += 1;
      }
      if (!corpusManifestPath || !suitePath || !predictionsPath || !systemRunManifestPath
          || !scoreReportPath || !gateReportPath || !recommendationsPath || !outputPath) {
        return {
          kind: "error",
          message: "export-promotion-development-evidence requires --corpus-manifest, --suite, --predictions, --system-run-manifest, --score, --gate, --recommendations, and --output."
        };
      }
      return {
        kind: "governance-benchmark-export-promotion-development-evidence",
        corpusManifestPath,
        suitePath,
        predictionsPath,
        systemRunManifestPath,
        scoreReportPath,
        gateReportPath,
        recommendationsPath,
        outputPath
      };
    }
    if (subcommand === "gate-promotion-confirmatory") {
      let suitePath: string | undefined;
      let predictionsPath: string | undefined;
      let systemRunManifestPath: string | undefined;
      let recoveryManifestPath: string | undefined;
      let ungated: string | undefined;
      let checklist: string | undefined;
      let manuscript: string | undefined;
      let full: string | undefined;
      const ablations: string[] = [];
      const providerRunManifestPaths: string[] = [];
      let outDir = "outputs/governance-benchmark/promotion-confirmatory-gate";
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
          return { kind: "error", message: "Missing value for " + token + "." };
        }
        if (token === "--suite") suitePath = value;
        else if (token === "--predictions") predictionsPath = value;
        else if (token === "--system-run-manifest") systemRunManifestPath = value;
        else if (token === "--provider-run-manifest") providerRunManifestPaths.push(value);
        else if (token === "--recovery-manifest") recoveryManifestPath = value;
        else if (token === "--ungated-system") ungated = value;
        else if (token === "--checklist-system") checklist = value;
        else if (token === "--manuscript-system") manuscript = value;
        else if (token === "--full-system") full = value;
        else if (token === "--ablation-system") ablations.push(value);
        else if (token === "--out-dir") outDir = value;
        else {
          return {
            kind: "error",
            message: "Unsupported governance-benchmark gate-promotion-confirmatory argument: " + token
          };
        }
        index += 1;
      }
      if (!suitePath || !predictionsPath || !ungated || !checklist || !manuscript || !full) {
        return {
          kind: "error",
          message: "gate-promotion-confirmatory requires --suite, --predictions, --ungated-system, --checklist-system, --manuscript-system, and --full-system."
        };
      }
      return {
        kind: "governance-benchmark-gate-promotion-confirmatory",
        suitePath,
        predictionsPath,
        systemRunManifestPath,
        providerRunManifestPaths,
        recoveryManifestPath,
        systemRoles: { ungated, checklist, manuscript, full, ablations },
        outDir
      };
    }
    if (subcommand === "analyze-promotion-failures") {
      let suitePath: string | undefined;
      let predictionsPath: string | undefined;
      let systemId: string | undefined;
      let outDir = "outputs/governance-benchmark/promotion-failures";
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--suite" || token === "--predictions" || token === "--system" || token === "--out-dir") {
          const value = args[index + 1];
          if (!value) return { kind: "error", message: `Missing value for ${token}.` };
          if (token === "--suite") suitePath = value;
          else if (token === "--predictions") predictionsPath = value;
          else if (token === "--system") systemId = value;
          else outDir = value;
          index += 1;
          continue;
        }
        return { kind: "error", message: `Unsupported governance-benchmark analyze-promotion-failures argument: ${token}` };
      }
      if (!suitePath || !predictionsPath || !systemId) {
        return { kind: "error", message: "Missing required arguments: --suite, --predictions, and --system." };
      }
      return { kind: "governance-benchmark-analyze-promotion-failures", suitePath, predictionsPath, systemId, outDir };
    }
    if (subcommand === "score-promotion") {
      let suitePath: string | undefined;
      let predictionsPath: string | undefined;
      let outDir: string | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--suite" || token === "--predictions" || token === "--out-dir") {
          const value = args[index + 1];
          if (!value) return { kind: "error", message: `Missing value for ${token}.` };
          if (token === "--suite") suitePath = value;
          else if (token === "--predictions") predictionsPath = value;
          else outDir = value;
          index += 1;
          continue;
        }
        return { kind: "error", message: `Unsupported governance-benchmark score-promotion argument: ${token}` };
      }
      if (!suitePath || !predictionsPath) {
        return { kind: "error", message: "Missing required arguments: --suite <suite.json> and --predictions <predictions.jsonl>." };
      }
      return { kind: "governance-benchmark-score-promotion", suitePath, predictionsPath, outDir };
    }
    if (subcommand === "export-bundles") {
      const publicOutputRoots: string[] = [];
      let outDir: string | undefined;
      let maxBundles: number | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--source" || token === "--public-output") {
          const value = args[index + 1];
          if (!value) {
            return { kind: "error", message: `Missing value for ${token}.` };
          }
          publicOutputRoots.push(value);
          index += 1;
          continue;
        }
        if (token === "--max") {
          const value = args[index + 1];
          if (!value) {
            return { kind: "error", message: "Missing value for --max." };
          }
          const parsed = Number(value);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            return { kind: "error", message: `Invalid max: ${value}` };
          }
          maxBundles = Math.floor(parsed);
          index += 1;
          continue;
        }
        if (token === "--out-dir") {
          const value = args[index + 1];
          if (!value) {
            return { kind: "error", message: "Missing value for --out-dir." };
          }
          outDir = value;
          index += 1;
          continue;
        }
        return {
          kind: "error",
          message: `Unsupported governance-benchmark export-bundles argument: ${token}`
        };
      }
      if (publicOutputRoots.length === 0) {
        return { kind: "error", message: "Missing required argument: --source <outputs/run>." };
      }
      return { kind: "governance-benchmark-export-bundles", publicOutputRoots, outDir, maxBundles };
    }
    if (subcommand === "batch") {
      let seedsRoot: string | undefined;
      let outDir: string | undefined;
      const taskIds: string[] = [];
      const conditions: GovernanceBenchmarkConditionName[] = [];
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--seeds" || token === "--source") {
          const value = args[index + 1];
          if (!value) {
            return { kind: "error", message: `Missing value for ${token}.` };
          }
          seedsRoot = value;
          index += 1;
          continue;
        }
        if (token === "--task") {
          const value = args[index + 1];
          if (!value) {
            return { kind: "error", message: "Missing value for --task." };
          }
          taskIds.push(value);
          index += 1;
          continue;
        }
        if (token === "--condition") {
          const value = args[index + 1];
          if (!value) {
            return { kind: "error", message: "Missing value for --condition." };
          }
          const condition = parseGovernanceBenchmarkCondition(value);
          if (!condition) {
            return {
              kind: "error",
              message: `Unsupported governance benchmark condition: ${value}.`
            };
          }
          conditions.push(condition);
          index += 1;
          continue;
        }
        if (token === "--out-dir") {
          const value = args[index + 1];
          if (!value) {
            return { kind: "error", message: "Missing value for --out-dir." };
          }
          outDir = value;
          index += 1;
          continue;
        }
        return {
          kind: "error",
          message: `Unsupported governance-benchmark batch argument: ${token}`
        };
      }
      if (!seedsRoot) {
        return { kind: "error", message: "Missing required argument: --seeds <path>." };
      }
      return { kind: "governance-benchmark-batch", seedsRoot, taskIds, outDir, conditions };
    }
    if (subcommand === "dry-run") {
      let seedPath: string | undefined;
      let taskId: string | undefined;
      let outDir: string | undefined;
      const conditions: GovernanceBenchmarkConditionName[] = [];
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--seed" || token === "--source") {
          const value = args[index + 1];
          if (!value) {
            return { kind: "error", message: `Missing value for ${token}.` };
          }
          seedPath = value;
          index += 1;
          continue;
        }
        if (token === "--task") {
          const value = args[index + 1];
          if (!value) {
            return { kind: "error", message: "Missing value for --task." };
          }
          taskId = value;
          index += 1;
          continue;
        }
        if (token === "--condition") {
          const value = args[index + 1];
          if (!value) {
            return { kind: "error", message: "Missing value for --condition." };
          }
          const condition = parseGovernanceBenchmarkCondition(value);
          if (!condition) {
            return {
              kind: "error",
              message: `Unsupported governance benchmark condition: ${value}.`
            };
          }
          conditions.push(condition);
          index += 1;
          continue;
        }
        if (token === "--out-dir") {
          const value = args[index + 1];
          if (!value) {
            return { kind: "error", message: "Missing value for --out-dir." };
          }
          outDir = value;
          index += 1;
          continue;
        }
        return {
          kind: "error",
          message: `Unsupported governance-benchmark dry-run argument: ${token}`
        };
      }
      if (!seedPath) {
        return { kind: "error", message: "Missing required argument: --seed <path>." };
      }
      return { kind: "governance-benchmark-dry-run", seedPath, taskId, outDir, conditions };
    }
    let sourcePath: string | undefined;
    let taskId: string | undefined;
    let outDir: string | undefined;
    let referenceOnly = false;
    for (let index = 2; index < args.length; index += 1) {
      const token = args[index];
      if (token === "--source") {
        const value = args[index + 1];
        if (!value) {
          return { kind: "error", message: "Missing value for --source." };
        }
        sourcePath = value;
        index += 1;
        continue;
      }
      if (token === "--task") {
        const value = args[index + 1];
        if (!value) {
          return { kind: "error", message: "Missing value for --task." };
        }
        taskId = value;
        index += 1;
        continue;
      }
      if (token === "--out-dir") {
        const value = args[index + 1];
        if (!value) {
          return { kind: "error", message: "Missing value for --out-dir." };
        }
        outDir = value;
        index += 1;
        continue;
      }
      if (token === "--reference-only") {
        referenceOnly = true;
        continue;
      }
      return {
        kind: "error",
        message: `Unsupported governance-benchmark seed argument: ${token}`
      };
    }
    if (!sourcePath) {
      return { kind: "error", message: "Missing required argument: --source <path>." };
    }
    return { kind: "governance-benchmark-seed", sourcePath, taskId, outDir, referenceOnly };
  }

  if (first === "meta-harness") {
    let runs = 5;
    let runsProvided = false;
    const nodes: MetaHarnessNode[] = [];
    const externalRunRoots: string[] = [];
    let noApply = false;
    let dryRun = false;
    for (let index = 1; index < args.length; index += 1) {
      const token = args[index];
      if (token === "--runs") {
        const value = args[index + 1];
        if (!value) {
          return { kind: "error", message: "Missing value for --runs." };
        }
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return { kind: "error", message: `Invalid run count: ${value}` };
        }
        runs = Math.floor(parsed);
        runsProvided = true;
        index += 1;
        continue;
      }
      if (token === "--external-run") {
        const value = args[index + 1];
        if (!value) {
          return { kind: "error", message: "Missing value for --external-run." };
        }
        externalRunRoots.push(value);
        index += 1;
        continue;
      }
      if (token === "--node") {
        const value = args[index + 1];
        if (!value) {
          return { kind: "error", message: "Missing value for --node." };
        }
        if (!(META_HARNESS_CLI_NODES as readonly string[]).includes(value)) {
          return {
            kind: "error",
            message: `Unsupported meta-harness node: ${value}. Expected ${META_HARNESS_CLI_NODES.join(", ")}.`
          };
        }
        nodes.push(value as MetaHarnessNode);
        index += 1;
        continue;
      }
      if (token === "--no-apply") {
        noApply = true;
        continue;
      }
      if (token === "--dry-run") {
        dryRun = true;
        continue;
      }
      return {
        kind: "error",
        message: `Unsupported meta-harness argument: ${token}`
      };
    }
    if (externalRunRoots.length > 0 && !noApply) {
      return {
        kind: "error",
        message: "meta-harness --external-run is read-only in this slice; pass --no-apply."
      };
    }
    if (externalRunRoots.length > 0 && dryRun) {
      return {
        kind: "error",
        message: "meta-harness --external-run does not support --dry-run in the read-only context slice."
      };
    }
    if (externalRunRoots.length > 0 && runsProvided) {
      return {
        kind: "error",
        message: "meta-harness --external-run cannot be combined with --runs in the first external context slice."
      };
    }
    return {
      kind: "meta-harness",
      runs: externalRunRoots.length > 0 ? 0 : runs,
      nodes: nodes.length > 0 ? nodes : ["analyze_results", "review"],
      externalRunRoots,
      noApply,
      dryRun
    };
  }

  return {
    kind: "error",
    message:
      "Unsupported CLI arguments. Run `autolabos`, `autolabos web`, `autolabos compare-analysis`, `autolabos eval-harness`, `autolabos evolve`, `autolabos meta-harness`, or use slash commands inside the TUI."
  };
}

function parseResearchArgs(args: string[]): CliAction {
  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return { kind: "research-help" };
  }
  if (!["new", "audit", "review", "improve", "pack"].includes(subcommand)) {
    return { kind: "error", message: "Usage: research <new|audit|review|improve|pack> [options]." };
  }
  if (args.slice(1).some((arg) => arg === "--help" || arg === "-h")) {
    return { kind: "research-help" };
  }

  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    const value = args[index + 1];
    if (!token?.startsWith("--")) {
      return { kind: "error", message: `Unexpected positional research argument: ${token || "<empty>"}.` };
    }
    if (values.has(token)) {
      return { kind: "error", message: `Duplicate research argument: ${token}.` };
    }
    if (!value || value.startsWith("--")) {
      return { kind: "error", message: `Missing value for ${token}.` };
    }
    values.set(token, value);
    index += 1;
  }

  const allowedByCommand: Record<string, string[]> = {
    new: ["--brief", "--out-dir"],
    audit: ["--run", "--external", "--draft", "--log", "--out-dir"],
    review: ["--gate", "--out-dir"],
    improve: ["--review", "--out-dir"],
    pack: ["--gate", "--review", "--source-dir", "--out-dir"]
  };
  const unsupported = [...values.keys()].find((key) => !allowedByCommand[subcommand].includes(key));
  if (unsupported) {
    return { kind: "error", message: `Unsupported research ${subcommand} argument: ${unsupported}` };
  }
  const outDir = values.get("--out-dir");

  if (subcommand === "new") {
    const briefPath = values.get("--brief");
    return briefPath
      ? { kind: "research-new", briefPath, outDir }
      : { kind: "error", message: "research new requires --brief <path>." };
  }
  if (subcommand === "audit") {
    const runRoot = values.get("--run");
    const externalRoot = values.get("--external");
    const draftPath = values.get("--draft");
    const logPath = values.get("--log");
    if ([runRoot, externalRoot].filter(Boolean).length !== 1) {
      return { kind: "error", message: "research audit requires exactly one of --run or --external." };
    }
    if (!externalRoot && (draftPath || logPath)) {
      return { kind: "error", message: "research audit --draft and --log require --external." };
    }
    return { kind: "research-audit", runRoot, externalRoot, draftPath, logPath, outDir };
  }
  if (subcommand === "review") {
    const gatePath = values.get("--gate");
    return gatePath
      ? { kind: "research-review", gatePath, outDir }
      : { kind: "error", message: "research review requires --gate <gate-report.json>." };
  }
  if (subcommand === "improve") {
    const reviewPath = values.get("--review");
    return reviewPath
      ? { kind: "research-improve", reviewPath, outDir }
      : { kind: "error", message: "research improve requires --review <review-report.json>." };
  }
  const gatePath = values.get("--gate");
  const reviewPath = values.get("--review");
  if (!gatePath || !reviewPath) {
    return { kind: "error", message: "research pack requires --gate <gate-report.json> and --review <review-report.json>." };
  }
  return {
    kind: "research-pack",
    gatePath,
    reviewPath,
    sourceDir: values.get("--source-dir"),
    outDir
  };
}

function parseGovernanceBenchmarkCondition(value: string): GovernanceBenchmarkConditionName | undefined {
  if (
    value === "gated"
    || value === "ungated"
    || value === "no_claim_ceiling"
    || value === "no_review_gate"
    || value === "no_figure_audit"
  ) {
    return value;
  }
  return undefined;
}

const VALID_NODE_OPTION_PACKAGES: NodeOptionPackageName[] = ["fast", "thorough", "paper_scale"];

function parseRunPackageArgs(args: string[]): CliAction | undefined {
  if (args[0] !== "--package" && args[0] !== "--benchmark-condition") {
    return undefined;
  }

  let packageName: NodeOptionPackageName | undefined;
  let benchmarkCondition: GovernanceBenchmarkConditionName | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--package") {
      const value = args[index + 1];
      if (!value) {
        return { kind: "error", message: "Missing value for --package." };
      }
      if (!isNodeOptionPackageName(value)) {
        return {
          kind: "error",
          message: `Unsupported package: ${value}. Expected one of ${VALID_NODE_OPTION_PACKAGES.join(", ")}.`
        };
      }
      packageName = value;
      index += 1;
      continue;
    }
    if (token === "--benchmark-condition") {
      const value = args[index + 1];
      if (!value) {
        return { kind: "error", message: "Missing value for --benchmark-condition." };
      }
      benchmarkCondition = parseGovernanceBenchmarkCondition(value);
      if (!benchmarkCondition) {
        return { kind: "error", message: `Unsupported governance benchmark condition: ${value}.` };
      }
      index += 1;
      continue;
    }
    return {
      kind: "error",
      message: `Unsupported run argument: ${token}`
    };
  }

  return {
    kind: "run",
    ...(packageName ? { packageName } : {}),
    ...(benchmarkCondition ? { benchmarkCondition } : {})
  };
}

function isNodeOptionPackageName(value: string): value is NodeOptionPackageName {
  return VALID_NODE_OPTION_PACKAGES.includes(value as NodeOptionPackageName);
}
