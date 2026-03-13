import { launchTerminalApp } from "./tui/TerminalApp.js";
import { bootstrapAutoLabOSRuntime } from "./runtime/createRuntime.js";
import {
  configExists,
  resolveAppPaths,
  resolveOpenAiApiKey,
  resolveSemanticScholarApiKey,
  runNonInteractiveSetup
} from "./config.js";

export async function runAutoLabOSApp(): Promise<void> {
  const paths = resolveAppPaths(process.cwd());
  if (!(await configExists(paths))) {
    await runNonInteractiveSetup(paths, {
      semanticScholarApiKey: (await resolveSemanticScholarApiKey(paths.cwd)) ?? "",
      openAiApiKey: await resolveOpenAiApiKey(paths.cwd)
    });
  }
  const bootstrap = await bootstrapAutoLabOSRuntime({
    cwd: process.cwd(),
    allowInteractiveSetup: false
  });
  if (!bootstrap.runtime || !bootstrap.config) {
    throw new Error("AutoLabOS runtime could not be initialized.");
  }
  await launchTerminalApp({
    config: bootstrap.runtime.config,
    runStore: bootstrap.runtime.runStore,
    titleGenerator: bootstrap.runtime.titleGenerator,
    codex: bootstrap.runtime.codex,
    openAiTextClient: bootstrap.runtime.openAiTextClient,
    eventStream: bootstrap.runtime.eventStream,
    orchestrator: bootstrap.runtime.orchestrator,
    initialRunId: undefined,
    semanticScholarApiKeyConfigured: bootstrap.runtime.semanticScholarApiKeyConfigured,
    onQuit: () => {
      process.stdout.write("\nBye\n");
    },
    saveConfig: bootstrap.runtime.saveConfig
  });
}
