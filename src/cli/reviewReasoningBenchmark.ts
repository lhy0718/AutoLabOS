import path from "node:path";
import { promises as fs } from "node:fs";

import {
  configExists,
  hydrateProcessEnvFromWorkspace,
  loadConfig,
  resolveAppPaths,
  resolveOpenAiApiKey
} from "../config.js";
import {
  createReviewReasoningBenchmarkSuiteV1,
  renderReviewReasoningBenchmarkMarkdown,
  runReviewReasoningBenchmark,
  validateReviewReasoningBenchmarkSuite,
  type ReviewReasoningBenchmarkEffort,
  type ReviewReasoningBenchmarkObservation,
  type ReviewReasoningBenchmarkSplit
} from "../core/evaluation/reviewReasoningBenchmark.js";
import {
  CodexOAuthResponsesLLMClient,
  OpenAiResponsesLLMClient,
  type LLMClient
} from "../core/llm/client.js";
import { resolveCodexOAuthCredentials } from "../integrations/codex/oauthAuth.js";
import { CodexOAuthResponsesTextClient } from "../integrations/codex/oauthResponsesTextClient.js";
import { OpenAiResponsesTextClient } from "../integrations/openai/responsesTextClient.js";
import { DEFAULT_CODEX_MODEL } from "../integrations/codex/modelCatalog.js";
import { DEFAULT_OPENAI_RESPONSES_MODEL } from "../integrations/openai/modelCatalog.js";
import { ensureDir, writeJsonFile } from "../utils/fs.js";

export type ReviewReasoningBenchmarkProvider = "codex" | "openai";

export interface ReviewReasoningBenchmarkCliOptions {
  cwd: string;
  provider?: ReviewReasoningBenchmarkProvider;
  model?: string;
  efforts?: ReviewReasoningBenchmarkEffort[];
  repetitions?: number;
  split?: ReviewReasoningBenchmarkSplit;
  outputDir?: string;
  dryRun?: boolean;
  now?: () => Date;
}

export interface ReviewReasoningBenchmarkCliResult {
  output_dir: string;
  suite_path: string;
  preflight_path: string;
  report_path?: string;
  markdown_path?: string;
}

export async function runReviewReasoningBenchmarkCli(
  options: ReviewReasoningBenchmarkCliOptions
): Promise<ReviewReasoningBenchmarkCliResult> {
  await hydrateProcessEnvFromWorkspace(options.cwd);
  const paths = resolveAppPaths(options.cwd);
  const hasConfig = await configExists(paths);
  if (!hasConfig && !options.dryRun) {
    throw new Error("Review reasoning benchmark requires an initialized AutoLabOS workspace.");
  }
  const config = hasConfig ? await loadConfig(paths) : undefined;
  const provider = options.provider || (
    config?.providers.llm_mode === "openai_api" ? "openai" : "codex"
  );
  const model = options.model || (
    provider === "openai"
      ? config?.providers.openai.model || DEFAULT_OPENAI_RESPONSES_MODEL
      : config?.providers.codex.model || DEFAULT_CODEX_MODEL
  );
  const efforts = options.efforts || (
    provider === "openai" ? ["high", "xhigh", "max"] : ["high", "xhigh"]
  );
  if (provider === "codex" && efforts.includes("max")) {
    throw new Error("The Codex surface does not support max reasoning. Use --provider openai for max.");
  }

  const repetitions = options.repetitions ?? 3;
  const split = options.split || "test";
  const now = options.now || (() => new Date());
  const runStamp = now().toISOString().replace(/[:.]/g, "-");
  const outputDir = options.outputDir
    ? path.resolve(options.cwd, options.outputDir)
    : path.join(paths.outputsDir, "review-reasoning-benchmark", runStamp);
  await ensureDir(outputDir);
  const suite = createReviewReasoningBenchmarkSuiteV1();
  const suiteValidation = validateReviewReasoningBenchmarkSuite(suite);
  const suitePath = path.join(outputDir, "suite.json");
  const preflightPath = path.join(outputDir, "preflight.json");
  await writeJsonFile(suitePath, suite);
  await writeJsonFile(preflightPath, {
    schema_version: 1,
    artifact_type: "ReviewReasoningBenchmarkPreflight",
    generated_at: now().toISOString(),
    provider,
    model,
    efforts,
    repetitions,
    split,
    dry_run: options.dryRun === true,
    suite_validation: suiteValidation,
    policy_scope: "internal_model_routing_only",
    policy_change_authorized: false
  });
  if (!suiteValidation.valid) {
    throw new Error(`Review reasoning benchmark preflight failed: ${suiteValidation.errors.join(" ")}`);
  }
  if (options.dryRun) {
    process.stdout.write(`Review reasoning benchmark preflight passed: ${preflightPath}\n`);
    return { output_dir: outputDir, suite_path: suitePath, preflight_path: preflightPath };
  }

  const llm = createBenchmarkLlm(provider, config!, paths.cwd);
  const rawDir = path.join(outputDir, "raw");
  await ensureDir(rawDir);
  const report = await runReviewReasoningBenchmark({
    llm,
    provider,
    model,
    efforts,
    repetitions,
    split,
    suite,
    now,
    onObservation: async (observation) => {
      await persistObservation(rawDir, observation);
    }
  });
  const reportPath = path.join(outputDir, "report.json");
  const markdownPath = path.join(outputDir, "report.md");
  await writeJsonFile(reportPath, report);
  await fs.writeFile(markdownPath, renderReviewReasoningBenchmarkMarkdown(report), "utf8");
  process.stdout.write(`${renderReviewReasoningBenchmarkMarkdown(report)}\nArtifacts: ${outputDir}\n`);
  return {
    output_dir: outputDir,
    suite_path: suitePath,
    preflight_path: preflightPath,
    report_path: reportPath,
    markdown_path: markdownPath
  };
}

function createBenchmarkLlm(
  provider: ReviewReasoningBenchmarkProvider,
  config: Awaited<ReturnType<typeof loadConfig>>,
  cwd: string
): LLMClient {
  if (provider === "openai") {
    const client = new OpenAiResponsesTextClient(() => resolveOpenAiApiKey(cwd));
    return new OpenAiResponsesLLMClient(client, {
      model: config.providers.openai.model,
      reasoningEffort: config.providers.openai.reasoning_effort
    });
  }
  const client = new CodexOAuthResponsesTextClient(() => resolveCodexOAuthCredentials(), {
    model: config.providers.codex.model,
    reasoningEffort: config.providers.codex.reasoning_effort
  });
  return new CodexOAuthResponsesLLMClient(client, {
    model: config.providers.codex.model,
    reasoningEffort: config.providers.codex.reasoning_effort
  });
}

async function persistObservation(
  rawDir: string,
  observation: ReviewReasoningBenchmarkObservation
): Promise<void> {
  const stem = observation.observation_id.replace(/[^a-zA-Z0-9._-]/g, "_");
  await fs.writeFile(path.join(rawDir, `${stem}.txt`), observation.raw_response, "utf8");
  await writeJsonFile(path.join(rawDir, `${stem}.receipt.json`), {
    ...observation,
    raw_response: undefined
  });
}
