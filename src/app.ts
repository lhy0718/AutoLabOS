import { configExists, ensureScaffold, loadConfig, resolveAppPaths, runSetupWizard, saveConfig } from "./config.js";
import { RunStore } from "./core/runs/runStore.js";
import { TitleGenerator } from "./core/runs/titleGenerator.js";
import { CodexCliClient } from "./integrations/codex/codexCliClient.js";
import { AgentOrchestrator } from "./core/agents/agentOrchestrator.js";
import { launchTerminalApp } from "./tui/TerminalApp.js";
import { InMemoryEventStream } from "./core/events.js";
import { CodexLLMClient } from "./core/llm/client.js";
import { LocalAciAdapter } from "./tools/aciLocalAdapter.js";
import { SemanticScholarClient } from "./tools/semanticScholar.js";
import { DefaultNodeRegistry } from "./core/stateGraph/nodeRegistry.js";
import { CheckpointStore } from "./core/stateGraph/checkpointStore.js";
import { StateGraphRuntime } from "./core/stateGraph/runtime.js";
import { askLine } from "./utils/prompt.js";
import { AppConfig } from "./types.js";

export async function runAutoresearchApp(): Promise<void> {
  const paths = resolveAppPaths(process.cwd());
  await ensureScaffold(paths);

  const firstRunSetup = !(await configExists(paths));
  let config;
  if (firstRunSetup) {
    process.stdout.write("AutoResearch setup wizard (first run)\n\n");
    config = await runSetupWizard(paths);
    process.stdout.write("\nSetup completed.\n");
  } else {
    config = await loadConfig(paths);
  }

  const runStore = new RunStore(paths);
  const codex = new CodexCliClient(paths.cwd, {
    model: config.providers.codex.model || "gpt-5.3-codex",
    reasoningEffort: config.providers.codex.reasoning_effort || "xhigh"
  });
  const titleGenerator = new TitleGenerator(codex);
  const initialRunId = await maybeCreateInitialRun({
    firstRunSetup,
    runStore,
    titleGenerator,
    config
  });

  const eventStream = new InMemoryEventStream();
  const llm = new CodexLLMClient(codex);
  const aci = new LocalAciAdapter();
  const semanticScholar = new SemanticScholarClient({
    apiKey: config.papers.semantic_scholar_api_key || undefined,
    perSecondLimit: config.papers.per_second_limit,
    maxRetries: 3
  });

  const nodeRegistry = new DefaultNodeRegistry({
    config,
    eventStream,
    llm,
    aci,
    semanticScholar
  });

  const checkpointStore = new CheckpointStore(paths);
  const runtime = new StateGraphRuntime(runStore, nodeRegistry, checkpointStore, eventStream);
  const orchestrator = new AgentOrchestrator(runStore, runtime, checkpointStore);

  await launchTerminalApp({
    config,
    runStore,
    titleGenerator,
    codex,
    orchestrator,
    initialRunId,
    onQuit: () => {
      process.stdout.write("\nBye\n");
    },
    saveConfig: async (nextConfig) => {
      await saveConfig(paths, nextConfig);
    }
  });
}

interface InitialRunArgs {
  firstRunSetup: boolean;
  runStore: RunStore;
  titleGenerator: TitleGenerator;
  config: AppConfig;
}

async function maybeCreateInitialRun(args: InitialRunArgs): Promise<string | undefined> {
  const runs = await args.runStore.listRuns();
  if (!args.firstRunSetup) {
    return undefined;
  }
  if (runs.length > 0) {
    return runs[0].id;
  }

  const answer = (await askLine("Create your first run now? (Y/n)", "Y")).trim().toLowerCase();
  if (["n", "no"].includes(answer)) {
    process.stdout.write("Skipping initial run creation.\n");
    process.stdout.write("Launching dashboard...\n");
    return undefined;
  }

  const topic = args.config.research.default_topic;
  const constraints = args.config.research.default_constraints;
  const objectiveMetric = args.config.research.default_objective_metric;

  process.stdout.write("Creating first run with current defaults...\n");
  const title = await args.titleGenerator.generateTitle(topic, constraints, objectiveMetric);
  const run = await args.runStore.createRun({
    title,
    topic,
    constraints,
    objectiveMetric
  });

  process.stdout.write(`First run created: ${run.id}\n`);
  process.stdout.write("Launching dashboard...\n");
  return run.id;
}
