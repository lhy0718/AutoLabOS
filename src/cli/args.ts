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
  | { kind: "governance-benchmark-build-promotion"; recipePath: string; freezeManifestPath?: string; outDir: string }
  | { kind: "governance-benchmark-run-promotion"; suitePath: string; systems: PromotionBenchmarkSystemName[]; trialId?: string; outDir?: string }
  | { kind: "governance-benchmark-run-promotion-provider"; suitePath: string; provider: "openai" | "ollama"; model: string; reasoningEffort: string; systemId: string; trialId: string; outDir: string; baseUrl?: string }
  | { kind: "governance-benchmark-aggregate-promotion-provider-runs"; suitePath: string; runManifestPaths: string[]; outDir: string }
  | { kind: "governance-benchmark-export-promotion-prompts"; suitePath: string; outDir: string }
  | { kind: "governance-benchmark-import-promotion-responses"; requestMapPath: string; responsesPath: string; systemId: string; trialId: string; outDir: string }
  | { kind: "governance-benchmark-export-promotion-annotations"; suitePath: string; outDir: string }
  | { kind: "governance-benchmark-export-promotion-mutation-audit"; suitePath: string; outDir: string }
  | { kind: "governance-benchmark-verify-promotion-mutations"; suitePath: string; privateMapPath: string; auditPaths: string[]; outDir: string }
  | { kind: "governance-benchmark-adjudicate-promotion"; suitePath: string; privateMapPath: string; annotationPaths: string[]; resolutionPath?: string; mutationAuditReportPath?: string; outDir: string }
  | { kind: "governance-benchmark-generate-promotion-development"; outDir: string; baseBundleCount?: number }
  | { kind: "governance-benchmark-audit-promotion-source-expansion"; inventoryPath: string; outDir: string }
  | { kind: "governance-benchmark-export-promotion-trial-candidates"; recipePath: string; sourceRoot: string; outDir: string }
  | { kind: "governance-benchmark-prepare-promotion-trial-candidate-review-campaign"; handoffRoot: string; annotatorIds: string[]; licenseReviewerId: string; outDir: string }
  | { kind: "governance-benchmark-export-promotion-trial-candidate-review-distribution"; campaignRoot: string; outDir: string }
  | { kind: "governance-benchmark-collect-promotion-trial-candidate-review-campaign"; campaignRoot: string; handoffRoot: string; annotationPaths: string[]; licenseReviewPath: string; resolutionPath?: string; outDir: string }
  | { kind: "governance-benchmark-prepare-promotion-trial-candidate-worksheet"; handoffRoot: string; annotatorId: string; outputPath: string }
  | { kind: "governance-benchmark-prepare-promotion-trial-candidate-review-workspace"; packageRoot: string; outDir: string }
  | { kind: "governance-benchmark-audit-promotion-trial-candidate-review-workspace"; workspaceRoot: string; outDir: string }
  | { kind: "governance-benchmark-finalize-promotion-trial-candidate-review-workspace"; workspaceRoot: string; outputPath: string }
  | { kind: "governance-benchmark-prepare-promotion-trial-candidate-license-worksheet"; handoffRoot: string; reviewerId: string; outputPath: string }
  | { kind: "governance-benchmark-preflight-promotion-trial-candidate-annotation"; reviewerRoot: string; annotationPath: string; outDir: string }
  | { kind: "governance-benchmark-preflight-promotion-trial-candidate-license-review"; licenseRoot: string; reviewPath: string; outDir: string }
  | { kind: "governance-benchmark-adjudicate-promotion-trial-candidate-review"; handoffRoot: string; annotationPaths: string[]; licenseReviewPath: string; resolutionPath?: string; outDir: string }
  | { kind: "governance-benchmark-prepare-promotion-canonical-curation"; handoffRoot: string; campaignReturnRoot: string; curatorId: string; verifierId: string; curatorProtocolVersion: string; verifierProtocolVersion: string; outDir: string }
  | { kind: "governance-benchmark-collect-promotion-canonical-curation"; curationHandoffRoot: string; sourceRoots: string[]; outDir: string }
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
  | { kind: "governance-benchmark-run-promotion-development-recovery"; suitePath: string; predictionsPath: string; systemRunManifestPath: string; repairedSuiteId: string; repairedTrialId: string; outDir: string }
  | { kind: "governance-benchmark-evaluate-promotion-recovery"; manifestPath: string; outDir: string }
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
  | { kind: "research-pack-verify"; bundleRoot: string }
  | { kind: "research-milestone-verify"; contractPath: string; outDir: string }
  | { kind: "research-validation-run"; profilePath: string; outDir: string }
  | { kind: "research-help" }
  | { kind: "reference-review-prepare"; claimsPath: string; statusPath: string; lockPath: string; outDir: string }
  | { kind: "reference-review-distribute-private"; packetRoot: string; sourceDir: string; outDir: string }
  | { kind: "reference-review-package-private"; distributionRoot: string; outDir: string }
  | { kind: "reference-review-verify-private-package"; packageRoot: string }
  | { kind: "reference-review-preflight"; packetRoot: string; reviewPath: string; outDir: string }
  | { kind: "reference-review-import"; packetRoot: string; reviewPath: string; preflightReportPath: string; approvalPath: string; claimsPath: string; outDir: string }
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

  if (first === "reference-review") {
    return parseReferenceReviewArgs(args.slice(1));
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
    if (subcommand === "prepare-promotion-trial-candidate-review-workspace") {
      let packageRoot: string | undefined;
      let outDir: string | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--package-root" && token !== "--out-dir") {
          return { kind: "error", message: `Unsupported governance-benchmark prepare-promotion-trial-candidate-review-workspace argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
          return { kind: "error", message: `Missing value for ${token}.` };
        }
        if (token === "--package-root") packageRoot = value;
        else outDir = value;
        index += 1;
      }
      if (!packageRoot || !outDir) {
        return { kind: "error", message: "Missing required arguments: --package-root and --out-dir are required." };
      }
      return {
        kind: "governance-benchmark-prepare-promotion-trial-candidate-review-workspace",
        packageRoot,
        outDir
      };
    }
    if (subcommand === "audit-promotion-trial-candidate-review-workspace") {
      let workspaceRoot: string | undefined;
      let outDir: string | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--workspace-root" && token !== "--out-dir") {
          return { kind: "error", message: `Unsupported governance-benchmark audit-promotion-trial-candidate-review-workspace argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
          return { kind: "error", message: `Missing value for ${token}.` };
        }
        if (token === "--workspace-root") workspaceRoot = value;
        else outDir = value;
        index += 1;
      }
      if (!workspaceRoot || !outDir) {
        return { kind: "error", message: "Missing required arguments: --workspace-root and --out-dir are required." };
      }
      return {
        kind: "governance-benchmark-audit-promotion-trial-candidate-review-workspace",
        workspaceRoot,
        outDir
      };
    }
    if (subcommand === "finalize-promotion-trial-candidate-review-workspace") {
      let workspaceRoot: string | undefined;
      let outputPath: string | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--workspace-root" && token !== "--output") {
          return { kind: "error", message: `Unsupported governance-benchmark finalize-promotion-trial-candidate-review-workspace argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
          return { kind: "error", message: `Missing value for ${token}.` };
        }
        if (token === "--workspace-root") workspaceRoot = value;
        else outputPath = value;
        index += 1;
      }
      if (!workspaceRoot || !outputPath) {
        return { kind: "error", message: "Missing required arguments: --workspace-root and --output are required." };
      }
      return {
        kind: "governance-benchmark-finalize-promotion-trial-candidate-review-workspace",
        workspaceRoot,
        outputPath
      };
    }
    if (subcommand === "export-promotion-trial-candidate-review-distribution") {
      let campaignRoot: string | undefined;
      let outDir: string | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--campaign-root" && token !== "--out-dir") {
          return { kind: "error", message: `Unsupported governance-benchmark export-promotion-trial-candidate-review-distribution argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
          return { kind: "error", message: `Missing value for ${token}.` };
        }
        if (token === "--campaign-root") campaignRoot = value;
        else outDir = value;
        index += 1;
      }
      if (!campaignRoot || !outDir) {
        return {
          kind: "error",
          message: "Missing required arguments: --campaign-root and --out-dir are required."
        };
      }
      return {
        kind: "governance-benchmark-export-promotion-trial-candidate-review-distribution",
        campaignRoot,
        outDir
      };
    }
    if (subcommand !== "seed" && subcommand !== "dry-run" && subcommand !== "batch" && subcommand !== "export-bundles" && subcommand !== "generate-promotion-development" && subcommand !== "export-promotion-development-evidence" && subcommand !== "audit-promotion-source-expansion" && subcommand !== "export-promotion-trial-candidates" && subcommand !== "prepare-promotion-trial-candidate-review-campaign" && subcommand !== "collect-promotion-trial-candidate-review-campaign" && subcommand !== "prepare-promotion-trial-candidate-worksheet" && subcommand !== "prepare-promotion-trial-candidate-license-worksheet" && subcommand !== "preflight-promotion-trial-candidate-annotation" && subcommand !== "preflight-promotion-trial-candidate-license-review" && subcommand !== "adjudicate-promotion-trial-candidate-review" && subcommand !== "prepare-promotion-canonical-curation" && subcommand !== "collect-promotion-canonical-curation" && subcommand !== "project-promotion-source" && subcommand !== "export-promotion-source-normalization" && subcommand !== "export-promotion-source-normalization-batch" && subcommand !== "preflight-promotion-source-normalization-annotation" && subcommand !== "adjudicate-promotion-source-normalization-batch" && subcommand !== "materialize-promotion-source-normalization-batch" && subcommand !== "normalize-promotion-source" && subcommand !== "prepare-promotion-execution-evidence" && subcommand !== "audit-promotion-confirmatory" && subcommand !== "freeze-promotion-confirmatory" && subcommand !== "run-promotion-development-recovery" && subcommand !== "evaluate-promotion-recovery" && subcommand !== "gate-promotion-confirmatory" && subcommand !== "build-promotion" && subcommand !== "run-promotion" && subcommand !== "run-promotion-provider" && subcommand !== "aggregate-promotion-provider-runs" && subcommand !== "export-promotion-prompts" && subcommand !== "import-promotion-responses" && subcommand !== "export-promotion-annotations" && subcommand !== "export-promotion-mutation-audit" && subcommand !== "verify-promotion-mutations" && subcommand !== "adjudicate-promotion" && subcommand !== "analyze-promotion-failures" && subcommand !== "score-promotion") {
      return {
        kind: "error",
        message:
          "Usage: governance-benchmark seed|dry-run|batch|export-bundles|generate-promotion-development|export-promotion-development-evidence|audit-promotion-source-expansion|export-promotion-trial-candidates|prepare-promotion-trial-candidate-review-campaign|collect-promotion-trial-candidate-review-campaign|prepare-promotion-trial-candidate-worksheet|prepare-promotion-trial-candidate-license-worksheet|preflight-promotion-trial-candidate-annotation|preflight-promotion-trial-candidate-license-review|adjudicate-promotion-trial-candidate-review|prepare-promotion-canonical-curation|collect-promotion-canonical-curation|project-promotion-source|export-promotion-source-normalization|export-promotion-source-normalization-batch|preflight-promotion-source-normalization-annotation|adjudicate-promotion-source-normalization-batch|materialize-promotion-source-normalization-batch|normalize-promotion-source|prepare-promotion-execution-evidence|audit-promotion-confirmatory|freeze-promotion-confirmatory|run-promotion-development-recovery|evaluate-promotion-recovery|gate-promotion-confirmatory|build-promotion|run-promotion|run-promotion-provider|aggregate-promotion-provider-runs|export-promotion-prompts|import-promotion-responses|export-promotion-annotations|export-promotion-mutation-audit|verify-promotion-mutations|adjudicate-promotion|analyze-promotion-failures|score-promotion [options]."
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
      let sourceRoot: string | undefined;
      let outDir: string | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--recipe" && token !== "--source-root" && token !== "--out-dir") {
          return { kind: "error", message: `Unsupported governance-benchmark export-promotion-trial-candidates argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { kind: "error", message: `Missing value for ${token}.` };
        if (token === "--recipe") recipePath = value;
        else if (token === "--source-root") sourceRoot = value;
        else outDir = value;
        index += 1;
      }
      if (!recipePath || !sourceRoot || !outDir) {
        return { kind: "error", message: "Missing required arguments: --recipe, --source-root, and --out-dir are required." };
      }
      return {
        kind: "governance-benchmark-export-promotion-trial-candidates",
        recipePath,
        sourceRoot,
        outDir
      };
    }
    if (subcommand === "prepare-promotion-trial-candidate-review-campaign") {
      let handoffRoot: string | undefined;
      let licenseReviewerId: string | undefined;
      let outDir: string | undefined;
      const annotatorIds: string[] = [];
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--handoff-root" && token !== "--annotator-id"
            && token !== "--license-reviewer-id" && token !== "--out-dir") {
          return { kind: "error", message: `Unsupported governance-benchmark prepare-promotion-trial-candidate-review-campaign argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
          return { kind: "error", message: `Missing value for ${token}.` };
        }
        if (token === "--handoff-root") handoffRoot = value;
        else if (token === "--annotator-id") annotatorIds.push(value);
        else if (token === "--license-reviewer-id") licenseReviewerId = value;
        else outDir = value;
        index += 1;
      }
      if (!handoffRoot || annotatorIds.length !== 2 || !licenseReviewerId || !outDir) {
        return {
          kind: "error",
          message: "Missing required arguments: --handoff-root, exactly two --annotator-id values, --license-reviewer-id, and --out-dir are required."
        };
      }
      return {
        kind: "governance-benchmark-prepare-promotion-trial-candidate-review-campaign",
        handoffRoot,
        annotatorIds,
        licenseReviewerId,
        outDir
      };
    }
    if (subcommand === "collect-promotion-trial-candidate-review-campaign") {
      let campaignRoot: string | undefined;
      let handoffRoot: string | undefined;
      let licenseReviewPath: string | undefined;
      let resolutionPath: string | undefined;
      let outDir: string | undefined;
      const annotationPaths: string[] = [];
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--campaign-root" && token !== "--handoff-root"
            && token !== "--annotation" && token !== "--license-review"
            && token !== "--resolution" && token !== "--out-dir") {
          return { kind: "error", message: `Unsupported governance-benchmark collect-promotion-trial-candidate-review-campaign argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
          return { kind: "error", message: `Missing value for ${token}.` };
        }
        if (token === "--campaign-root") campaignRoot = value;
        else if (token === "--handoff-root") handoffRoot = value;
        else if (token === "--annotation") annotationPaths.push(value);
        else if (token === "--license-review") licenseReviewPath = value;
        else if (token === "--resolution") resolutionPath = value;
        else outDir = value;
        index += 1;
      }
      if (!campaignRoot || !handoffRoot || annotationPaths.length !== 2
          || !licenseReviewPath || !outDir) {
        return {
          kind: "error",
          message: "Missing required arguments: --campaign-root, --handoff-root, exactly two --annotation values, --license-review, and --out-dir are required."
        };
      }
      return {
        kind: "governance-benchmark-collect-promotion-trial-candidate-review-campaign",
        campaignRoot,
        handoffRoot,
        annotationPaths,
        licenseReviewPath,
        resolutionPath,
        outDir
      };
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
    if (subcommand === "prepare-promotion-trial-candidate-license-worksheet") {
      let handoffRoot: string | undefined;
      let reviewerId: string | undefined;
      let outputPath: string | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--handoff-root" && token !== "--reviewer-id" && token !== "--output") {
          return { kind: "error", message: `Unsupported governance-benchmark prepare-promotion-trial-candidate-license-worksheet argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { kind: "error", message: `Missing value for ${token}.` };
        if (token === "--handoff-root") handoffRoot = value;
        else if (token === "--reviewer-id") reviewerId = value;
        else outputPath = value;
        index += 1;
      }
      if (!handoffRoot || !reviewerId || !outputPath) {
        return { kind: "error", message: "Missing required arguments: --handoff-root, --reviewer-id, and --output are required." };
      }
      return {
        kind: "governance-benchmark-prepare-promotion-trial-candidate-license-worksheet",
        handoffRoot,
        reviewerId,
        outputPath
      };
    }
    if (subcommand === "preflight-promotion-trial-candidate-annotation") {
      let reviewerRoot: string | undefined;
      let annotationPath: string | undefined;
      let outDir: string | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--reviewer-root" && token !== "--annotation" && token !== "--out-dir") {
          return { kind: "error", message: `Unsupported governance-benchmark preflight-promotion-trial-candidate-annotation argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { kind: "error", message: `Missing value for ${token}.` };
        if (token === "--reviewer-root") reviewerRoot = value;
        else if (token === "--annotation") annotationPath = value;
        else outDir = value;
        index += 1;
      }
      if (!reviewerRoot || !annotationPath || !outDir) {
        return { kind: "error", message: "Missing required arguments: --reviewer-root, --annotation, and --out-dir are required." };
      }
      return {
        kind: "governance-benchmark-preflight-promotion-trial-candidate-annotation",
        reviewerRoot,
        annotationPath,
        outDir
      };
    }
    if (subcommand === "preflight-promotion-trial-candidate-license-review") {
      let licenseRoot: string | undefined;
      let reviewPath: string | undefined;
      let outDir: string | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--license-root" && token !== "--review" && token !== "--out-dir") {
          return { kind: "error", message: `Unsupported governance-benchmark preflight-promotion-trial-candidate-license-review argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { kind: "error", message: `Missing value for ${token}.` };
        if (token === "--license-root") licenseRoot = value;
        else if (token === "--review") reviewPath = value;
        else outDir = value;
        index += 1;
      }
      if (!licenseRoot || !reviewPath || !outDir) {
        return { kind: "error", message: "Missing required arguments: --license-root, --review, and --out-dir are required." };
      }
      return {
        kind: "governance-benchmark-preflight-promotion-trial-candidate-license-review",
        licenseRoot,
        reviewPath,
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
    if (subcommand === "prepare-promotion-canonical-curation") {
      let handoffRoot: string | undefined;
      let campaignReturnRoot: string | undefined;
      let curatorId: string | undefined;
      let verifierId: string | undefined;
      let curatorProtocolVersion: string | undefined;
      let verifierProtocolVersion: string | undefined;
      let outDir: string | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--handoff-root" && token !== "--campaign-return-root"
            && token !== "--curator-id" && token !== "--verifier-id"
            && token !== "--curator-protocol" && token !== "--verifier-protocol"
            && token !== "--out-dir") {
          return { kind: "error", message: `Unsupported governance-benchmark prepare-promotion-canonical-curation argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
          return { kind: "error", message: `Missing value for ${token}.` };
        }
        if (token === "--handoff-root") handoffRoot = value;
        else if (token === "--campaign-return-root") campaignReturnRoot = value;
        else if (token === "--curator-id") curatorId = value;
        else if (token === "--verifier-id") verifierId = value;
        else if (token === "--curator-protocol") curatorProtocolVersion = value;
        else if (token === "--verifier-protocol") verifierProtocolVersion = value;
        else outDir = value;
        index += 1;
      }
      if (!handoffRoot || !campaignReturnRoot || !curatorId || !verifierId
          || !curatorProtocolVersion || !verifierProtocolVersion || !outDir) {
        return {
          kind: "error",
          message: "Missing required arguments: --handoff-root, --campaign-return-root, --curator-id, --verifier-id, --curator-protocol, --verifier-protocol, and --out-dir are required."
        };
      }
      return {
        kind: "governance-benchmark-prepare-promotion-canonical-curation",
        handoffRoot,
        campaignReturnRoot,
        curatorId,
        verifierId,
        curatorProtocolVersion,
        verifierProtocolVersion,
        outDir
      };
    }
    if (subcommand === "collect-promotion-canonical-curation") {
      let curationHandoffRoot: string | undefined;
      let outDir: string | undefined;
      const sourceRoots: string[] = [];
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--curation-handoff-root" && token !== "--source-root"
            && token !== "--out-dir") {
          return { kind: "error", message: `Unsupported governance-benchmark collect-promotion-canonical-curation argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
          return { kind: "error", message: `Missing value for ${token}.` };
        }
        if (token === "--curation-handoff-root") curationHandoffRoot = value;
        else if (token === "--source-root") sourceRoots.push(value);
        else outDir = value;
        index += 1;
      }
      if (!curationHandoffRoot || sourceRoots.length === 0 || !outDir) {
        return {
          kind: "error",
          message: "Missing required arguments: --curation-handoff-root, at least one --source-root, and --out-dir are required."
        };
      }
      return {
        kind: "governance-benchmark-collect-promotion-canonical-curation",
        curationHandoffRoot,
        sourceRoots,
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
      let baseBundleCount: number | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token !== "--out-dir" && token !== "--base-count") {
          return { kind: "error", message: `Unsupported governance-benchmark generate-promotion-development argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value) return { kind: "error", message: `Missing value for ${token}.` };
        if (token === "--out-dir") {
          outDir = value;
        } else {
          baseBundleCount = Number(value);
          if (!Number.isInteger(baseBundleCount) || baseBundleCount < 1) {
            return { kind: "error", message: "--base-count must be a positive integer." };
          }
        }
        index += 1;
      }
      return {
        kind: "governance-benchmark-generate-promotion-development",
        outDir,
        ...(baseBundleCount !== undefined ? { baseBundleCount } : {})
      };
    }
    if (subcommand === "build-promotion") {
      let recipePath: string | undefined;
      let freezeManifestPath: string | undefined;
      let outDir = "outputs/governance-benchmark/promotion-suite";
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--recipe" || token === "--freeze-manifest" || token === "--out-dir") {
          const value = args[index + 1];
          if (!value) return { kind: "error", message: `Missing value for ${token}.` };
          if (token === "--recipe") recipePath = value;
          else if (token === "--freeze-manifest") freezeManifestPath = value;
          else outDir = value;
          index += 1;
          continue;
        }
        return { kind: "error", message: `Unsupported governance-benchmark build-promotion argument: ${token}` };
      }
      if (!recipePath) return { kind: "error", message: "Missing required argument: --recipe <recipe.json>." };
      return {
        kind: "governance-benchmark-build-promotion",
        recipePath,
        ...(freezeManifestPath ? { freezeManifestPath } : {}),
        outDir
      };
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
      let provider: "openai" | "ollama" | undefined;
      let model: string | undefined;
      let reasoningEffort: string | undefined;
      let systemId: string | undefined;
      let trialId: string | undefined;
      let outDir: string | undefined;
      let baseUrl: string | undefined;
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        if (!["--suite", "--provider", "--model", "--reasoning", "--system", "--trial", "--out-dir", "--base-url"].includes(token)) {
          return { kind: "error", message: `Unsupported governance-benchmark run-promotion-provider argument: ${token}` };
        }
        const value = args[index + 1];
        if (!value || value.startsWith("--")) return { kind: "error", message: `Missing value for ${token}.` };
        if (token === "--suite") suitePath = value;
        else if (token === "--provider") {
          if (value !== "openai" && value !== "ollama") {
            return { kind: "error", message: `Unsupported promotion provider: ${value}.` };
          }
          provider = value;
        } else if (token === "--model") model = value;
        else if (token === "--reasoning") reasoningEffort = value;
        else if (token === "--system") systemId = value;
        else if (token === "--trial") trialId = value;
        else if (token === "--out-dir") outDir = value;
        else baseUrl = value;
        index += 1;
      }
      if (!suitePath || !provider || !model || !reasoningEffort || !systemId || !trialId || !outDir) {
        return {
          kind: "error",
          message: "run-promotion-provider requires --suite, --provider, --model, --reasoning, --system, --trial, and --out-dir."
        };
      }
      if (provider === "openai" && !buildOpenAiResponsesModelChoices().includes(model)) {
        return { kind: "error", message: `Unsupported OpenAI Responses model: ${model}.` };
      }
      if (provider === "openai" && !buildOpenAiResponsesReasoningChoices(model).includes(reasoningEffort)) {
        return { kind: "error", message: `Unsupported reasoning effort for ${model}: ${reasoningEffort}.` };
      }
      if (provider === "ollama" && reasoningEffort !== "off") {
        return { kind: "error", message: "Ollama promotion provider requires --reasoning off." };
      }
      if (provider === "openai" && baseUrl) {
        return { kind: "error", message: "--base-url is supported only for the Ollama provider." };
      }
      return {
        kind: "governance-benchmark-run-promotion-provider",
        suitePath,
        provider,
        model,
        reasoningEffort,
        systemId,
        trialId,
        outDir,
        ...(baseUrl ? { baseUrl } : {})
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
    if (subcommand === "run-promotion-development-recovery") {
      let suitePath: string | undefined;
      let predictionsPath: string | undefined;
      let systemRunManifestPath: string | undefined;
      let repairedSuiteId: string | undefined;
      let repairedTrialId: string | undefined;
      let outDir = "outputs/governance-benchmark/promotion-development-recovery";
      for (let index = 2; index < args.length; index += 1) {
        const token = args[index];
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
          return { kind: "error", message: "Missing value for " + token + "." };
        }
        if (token === "--suite") suitePath = value;
        else if (token === "--predictions") predictionsPath = value;
        else if (token === "--system-run-manifest") systemRunManifestPath = value;
        else if (token === "--repaired-suite-id") repairedSuiteId = value;
        else if (token === "--repaired-trial-id") repairedTrialId = value;
        else if (token === "--out-dir") outDir = value;
        else {
          return {
            kind: "error",
            message: "Unsupported governance-benchmark run-promotion-development-recovery argument: " + token
          };
        }
        index += 1;
      }
      if (!suitePath || !predictionsPath || !systemRunManifestPath || !repairedSuiteId || !repairedTrialId) {
        return {
          kind: "error",
          message: "run-promotion-development-recovery requires --suite, --predictions, --system-run-manifest, --repaired-suite-id, and --repaired-trial-id."
        };
      }
      return {
        kind: "governance-benchmark-run-promotion-development-recovery",
        suitePath,
        predictionsPath,
        systemRunManifestPath,
        repairedSuiteId,
        repairedTrialId,
        outDir
      };
    }
    if (subcommand === "evaluate-promotion-recovery") {
      let manifestPath: string | undefined;
      let outDir = "outputs/governance-benchmark/promotion-recovery";
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
        return {
          kind: "error",
          message: `Unsupported governance-benchmark evaluate-promotion-recovery argument: ${token}`
        };
      }
      if (!manifestPath) {
        return { kind: "error", message: "Missing required argument: --manifest <recovery-manifest.json>." };
      }
      return {
        kind: "governance-benchmark-evaluate-promotion-recovery",
        manifestPath,
        outDir
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

function parseReferenceReviewArgs(args: string[]): CliAction {
  const subcommand = args[0];
  if (subcommand !== "prepare" && subcommand !== "distribute-private" && subcommand !== "package-private" && subcommand !== "verify-private-package"
      && subcommand !== "preflight" && subcommand !== "import") {
    return {
      kind: "error",
      message: "Usage: reference-review prepare|distribute-private|package-private|verify-private-package|preflight|import [options]."
    };
  }
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    const value = args[index + 1];
    if (!token?.startsWith("--") || !value || value.startsWith("--")) {
      return { kind: "error", message: `Invalid reference-review argument: ${token || "<empty>"}.` };
    }
    if (values.has(token)) {
      return { kind: "error", message: `Duplicate reference-review argument: ${token}.` };
    }
    values.set(token, value);
    index += 1;
  }
  if (subcommand === "prepare") {
    const allowed = new Set(["--claims", "--status", "--lock", "--out-dir"]);
    const unsupported = [...values.keys()].find((key) => !allowed.has(key));
    if (unsupported) {
      return { kind: "error", message: `Unsupported reference-review prepare argument: ${unsupported}.` };
    }
    const claimsPath = values.get("--claims");
    const statusPath = values.get("--status");
    const lockPath = values.get("--lock");
    const outDir = values.get("--out-dir");
    return claimsPath && statusPath && lockPath && outDir
      ? { kind: "reference-review-prepare", claimsPath, statusPath, lockPath, outDir }
      : { kind: "error", message: "reference-review prepare requires --claims, --status, --lock, and --out-dir." };
  }
  if (subcommand === "distribute-private") {
    const allowed = new Set(["--packet", "--source-dir", "--out-dir"]);
    const unsupported = [...values.keys()].find((key) => !allowed.has(key));
    if (unsupported) {
      return { kind: "error", message: "Unsupported reference-review distribute-private argument: " + unsupported + "." };
    }
    const packetRoot = values.get("--packet");
    const sourceDir = values.get("--source-dir");
    const outDir = values.get("--out-dir");
    return packetRoot && sourceDir && outDir
      ? { kind: "reference-review-distribute-private", packetRoot, sourceDir, outDir }
      : { kind: "error", message: "reference-review distribute-private requires --packet, --source-dir, and --out-dir." };
  }
  if (subcommand === "package-private") {
    const allowed = new Set(["--distribution", "--out-dir"]);
    const unsupported = [...values.keys()].find((key) => !allowed.has(key));
    if (unsupported) {
      return { kind: "error", message: "Unsupported reference-review package-private argument: " + unsupported + "." };
    }
    const distributionRoot = values.get("--distribution");
    const outDir = values.get("--out-dir");
    return distributionRoot && outDir
      ? { kind: "reference-review-package-private", distributionRoot, outDir }
      : {
          kind: "error",
          message: "reference-review package-private requires --distribution and --out-dir."
        };
  }
  if (subcommand === "verify-private-package") {
    const allowed = new Set(["--package"]);
    const unsupported = [...values.keys()].find((key) => !allowed.has(key));
    if (unsupported) {
      return { kind: "error", message: "Unsupported reference-review verify-private-package argument: " + unsupported + "." };
    }
    const packageRoot = values.get("--package");
    return packageRoot
      ? { kind: "reference-review-verify-private-package", packageRoot }
      : {
          kind: "error",
          message: "reference-review verify-private-package requires --package."
        };
  }
  if (subcommand === "import") {
    const allowed = new Set(["--packet", "--review", "--preflight", "--approval", "--claims", "--out-dir"]);
    const unsupported = [...values.keys()].find((key) => !allowed.has(key));
    if (unsupported) {
      return { kind: "error", message: `Unsupported reference-review import argument: ${unsupported}.` };
    }
    const packetRoot = values.get("--packet");
    const reviewPath = values.get("--review");
    const preflightReportPath = values.get("--preflight");
    const approvalPath = values.get("--approval");
    const claimsPath = values.get("--claims");
    const outDir = values.get("--out-dir");
    return packetRoot && reviewPath && preflightReportPath && approvalPath && claimsPath && outDir
      ? {
          kind: "reference-review-import",
          packetRoot,
          reviewPath,
          preflightReportPath,
          approvalPath,
          claimsPath,
          outDir
        }
      : { kind: "error", message: "reference-review import requires --packet, --review, --preflight, --approval, --claims, and --out-dir." };
  }
  const allowed = new Set(["--packet", "--review", "--out-dir"]);
  const unsupported = [...values.keys()].find((key) => !allowed.has(key));
  if (unsupported) {
    return { kind: "error", message: `Unsupported reference-review preflight argument: ${unsupported}.` };
  }
  const packetRoot = values.get("--packet");
  const reviewPath = values.get("--review");
  const outDir = values.get("--out-dir");
  return packetRoot && reviewPath && outDir
    ? { kind: "reference-review-preflight", packetRoot, reviewPath, outDir }
    : { kind: "error", message: "reference-review preflight requires --packet, --review, and --out-dir." };
}

function parseResearchArgs(args: string[]): CliAction {
  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    return { kind: "research-help" };
  }
  if (!["new", "audit", "review", "improve", "pack", "verify-pack", "verify-milestone", "run-validation"].includes(subcommand)) {
    return { kind: "error", message: "Usage: research <new|audit|review|improve|pack|verify-pack|verify-milestone|run-validation> [options]." };
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
    pack: ["--gate", "--review", "--source-dir", "--out-dir"],
    "verify-pack": ["--root"],
    "verify-milestone": ["--contract", "--out-dir"],
    "run-validation": ["--profile", "--out-dir"]
  };
  const unsupported = [...values.keys()].find((key) => !allowedByCommand[subcommand].includes(key));
  if (unsupported) {
    return { kind: "error", message: `Unsupported research ${subcommand} argument: ${unsupported}` };
  }
  const outDir = values.get("--out-dir");

  if (subcommand === "verify-pack") {
    const bundleRoot = values.get("--root");
    return bundleRoot
      ? { kind: "research-pack-verify", bundleRoot }
      : { kind: "error", message: "research verify-pack requires --root <paper-readiness-bundle-dir>." };
  }

  if (subcommand === "verify-milestone") {
    const contractPath = values.get("--contract");
    return contractPath && outDir
      ? { kind: "research-milestone-verify", contractPath, outDir }
      : { kind: "error", message: "research verify-milestone requires --contract <milestone.json> and --out-dir <new-output-dir>." };
  }

  if (subcommand === "run-validation") {
    const profilePath = values.get("--profile");
    return profilePath && outDir
      ? { kind: "research-validation-run", profilePath, outDir }
      : { kind: "error", message: "research run-validation requires --profile <validation-profile.json> and --out-dir <new-output-dir>." };
  }

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
