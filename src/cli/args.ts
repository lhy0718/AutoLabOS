import { GovernanceBenchmarkConditionName } from "../core/benchmark/governanceCondition.js";
import type { MetaHarnessNode } from "../core/metaHarness/metaHarness.js";
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
  | { kind: "audit"; runRoot?: string; externalRoot?: string; draftPath?: string; logPath?: string; supportRoot?: string; supportManifestPath?: string; outDir?: string }
  | { kind: "audit-help" }
  | { kind: "research-new"; briefPath: string; outDir?: string }
  | { kind: "research-audit"; runRoot?: string; externalRoot?: string; draftPath?: string; logPath?: string; supportRoot?: string; supportManifestPath?: string; outDir?: string }
  | { kind: "research-review"; gatePath: string; modelReviewBundlePath?: string; outDir?: string }
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
  | { kind: "reference-review-prepare-workspace"; packageRoot: string; outDir: string }
  | { kind: "reference-review-audit-workspace"; workspaceRoot: string; outDir: string }
  | { kind: "reference-review-finalize-workspace"; workspaceRoot: string; outputPath: string }
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
    let supportRoot: string | undefined;
    let supportManifestPath: string | undefined;
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
      if (token === "--support-root" || token === "--support-manifest") {
        const value = args[index + 1];
        if (!value || value.startsWith("--")) {
          return { kind: "error", message: `Missing value for ${token}.` };
        }
        if (token === "--support-root") supportRoot = value;
        else supportManifestPath = value;
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
        message: "Usage: audit (--run <run-artifact-root> | --external <artifact-root> [--draft <draft.md>] [--log <run.log>] [--support-root <root> --support-manifest <manifest.json>]) [--out-dir outputs/audit]."
      };
    }
    if (Boolean(supportRoot) !== Boolean(supportManifestPath)) {
      return { kind: "error", message: "--support-root and --support-manifest must be supplied together." };
    }
    if (!externalRoot && (draftPath || logPath || supportRoot || supportManifestPath)) {
      return { kind: "error", message: "--draft, --log, --support-root, and --support-manifest require --external <artifact-root>." };
    }
    return { kind: "audit", runRoot, externalRoot, draftPath, logPath, supportRoot, supportManifestPath, outDir };
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
      && subcommand !== "prepare-workspace" && subcommand !== "audit-workspace"
      && subcommand !== "finalize-workspace"
      && subcommand !== "preflight" && subcommand !== "import") {
    return {
      kind: "error",
      message: "Usage: reference-review prepare|distribute-private|package-private|verify-private-package|prepare-workspace|audit-workspace|finalize-workspace|preflight|import [options]."
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
  if (subcommand === "prepare-workspace") {
    const allowed = new Set(["--package", "--out-dir"]);
    const unsupported = [...values.keys()].find((key) => !allowed.has(key));
    if (unsupported) {
      return { kind: "error", message: "Unsupported reference-review prepare-workspace argument: " + unsupported + "." };
    }
    const packageRoot = values.get("--package");
    const outDir = values.get("--out-dir");
    return packageRoot && outDir
      ? { kind: "reference-review-prepare-workspace", packageRoot, outDir }
      : {
          kind: "error",
          message: "reference-review prepare-workspace requires --package and --out-dir."
        };
  }
  if (subcommand === "audit-workspace") {
    const allowed = new Set(["--workspace", "--out-dir"]);
    const unsupported = [...values.keys()].find((key) => !allowed.has(key));
    if (unsupported) {
      return { kind: "error", message: "Unsupported reference-review audit-workspace argument: " + unsupported + "." };
    }
    const workspaceRoot = values.get("--workspace");
    const outDir = values.get("--out-dir");
    return workspaceRoot && outDir
      ? { kind: "reference-review-audit-workspace", workspaceRoot, outDir }
      : {
          kind: "error",
          message: "reference-review audit-workspace requires --workspace and --out-dir."
        };
  }
  if (subcommand === "finalize-workspace") {
    const allowed = new Set(["--workspace", "--output"]);
    const unsupported = [...values.keys()].find((key) => !allowed.has(key));
    if (unsupported) {
      return { kind: "error", message: "Unsupported reference-review finalize-workspace argument: " + unsupported + "." };
    }
    const workspaceRoot = values.get("--workspace");
    const outputPath = values.get("--output");
    return workspaceRoot && outputPath
      ? { kind: "reference-review-finalize-workspace", workspaceRoot, outputPath }
      : {
          kind: "error",
          message: "reference-review finalize-workspace requires --workspace and --output."
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
    audit: ["--run", "--external", "--draft", "--log", "--support-root", "--support-manifest", "--out-dir"],
    review: ["--gate", "--model-review", "--out-dir"],
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
    const supportRoot = values.get("--support-root");
    const supportManifestPath = values.get("--support-manifest");
    if ([runRoot, externalRoot].filter(Boolean).length !== 1) {
      return { kind: "error", message: "research audit requires exactly one of --run or --external." };
    }
    if (Boolean(supportRoot) !== Boolean(supportManifestPath)) {
      return { kind: "error", message: "research audit --support-root and --support-manifest must be supplied together." };
    }
    if (!externalRoot && (draftPath || logPath || supportRoot || supportManifestPath)) {
      return { kind: "error", message: "research audit --draft, --log, --support-root, and --support-manifest require --external." };
    }
    return { kind: "research-audit", runRoot, externalRoot, draftPath, logPath, supportRoot, supportManifestPath, outDir };
  }
  if (subcommand === "review") {
    const gatePath = values.get("--gate");
    const modelReviewBundlePath = values.get("--model-review");
    return gatePath
      ? {
          kind: "research-review",
          gatePath,
          ...(modelReviewBundlePath ? { modelReviewBundlePath } : {}),
          outDir
        }
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
