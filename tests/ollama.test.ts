import path from "node:path";
import { promises as fs } from "node:fs";
import os from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ensureScaffold,
  getDefaultPdfAnalysisModeForLlmMode,
  loadConfig,
  resolveAppPaths,
  runNonInteractiveSetup,
  runSetupWizard,
  saveConfig
} from "../src/config.js";
import type { AppConfig } from "../src/types.js";
import {
  DEFAULT_OLLAMA_BASE_URL,
  OllamaModelConfigurationError,
  buildOllamaModelChoices,
  buildOllamaModelOptions,
  getMissingOllamaModelRoles,
  normalizeOllamaModelNames,
  requireOllamaModel
} from "../src/integrations/ollama/modelCatalog.js";
import { OllamaClient } from "../src/integrations/ollama/ollamaClient.js";
import { OllamaPdfAnalysisClient } from "../src/integrations/ollama/ollamaPdfAnalysisClient.js";
import { OllamaLLMClient, RoutedLLMClient } from "../src/core/llm/client.js";
import { discoverOllamaModels } from "../src/web/server.js";

const CHAT_MODEL = "local-model-a:latest";
const RESEARCH_MODEL = "local-model-b:latest";
const EXPERIMENT_MODEL = "local-model-c:latest";
const VISION_MODEL = "local-model-d:latest";
const INSTALLED_MODELS = [CHAT_MODEL, RESEARCH_MODEL, EXPERIMENT_MODEL, VISION_MODEL];

const ORIGINAL_FAKE_RESPONSE = process.env.AUTOLABOS_FAKE_OLLAMA_RESPONSE;
const ORIGINAL_FAKE_SEQUENCE = process.env.AUTOLABOS_FAKE_OLLAMA_RESPONSE_SEQUENCE;

function makePromptReaderFromQuestionMap(questionMap: Record<string, string>) {
  return async (question: string, defaultValue = "") => {
    const match = Object.entries(questionMap).find(([prefix]) => question.startsWith(prefix));
    return match ? match[1] : defaultValue;
  };
}

function makeBaseConfig(): AppConfig {
  return {
    version: 1,
    project_name: "test-workspace",
    providers: {
      llm_mode: "openai_api",
      codex: {
        model: "gpt-5.4",
        chat_model: "gpt-5.4",
        experiment_model: "gpt-5.4",
        pdf_model: "gpt-5.4",
        reasoning_effort: "high",
        chat_reasoning_effort: "low",
        experiment_reasoning_effort: "high",
        command_reasoning_effort: "low",
        fast_mode: false,
        chat_fast_mode: false,
        experiment_fast_mode: false,
        pdf_fast_mode: false,
        auth_required: true
      },
      openai: {
        model: "gpt-5.4",
        chat_model: "gpt-5.4",
        experiment_model: "gpt-5.4",
        pdf_model: "gpt-5.4",
        reasoning_effort: "high",
        chat_reasoning_effort: "low",
        experiment_reasoning_effort: "high",
        command_reasoning_effort: "low",
        api_key_required: true
      }
    },
    analysis: {
      responses_model: "gpt-5.4",
      responses_reasoning_effort: "high"
    },
    papers: { max_results: 200, per_second_limit: 1 },
    research: {
      default_topic: "",
      default_constraints: [],
      default_objective_metric: ""
    },
    workflow: { mode: "agent_approval", wizard_enabled: true, approval_mode: "minimal" },
    experiments: { runner: "local_python", timeout_sec: 3600, allow_network: false },
    paper: { template: "acl", build_pdf: true, latex_engine: "auto_install" },
    paths: { runs_dir: ".autolabos/runs", logs_dir: ".autolabos/logs" }
  };
}

function makeOllamaConfig(): AppConfig {
  const config = makeBaseConfig();
  config.providers.llm_mode = "ollama";
  config.providers.ollama = {
    base_url: DEFAULT_OLLAMA_BASE_URL,
    chat_model: CHAT_MODEL,
    research_model: RESEARCH_MODEL,
    experiment_model: EXPERIMENT_MODEL,
    vision_model: VISION_MODEL
  };
  return config;
}

async function createWorkspace(config: AppConfig = makeBaseConfig()) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-ollama-test-"));
  const paths = resolveAppPaths(cwd);
  await ensureScaffold(paths);
  await saveConfig(paths, config);
  return { cwd, paths };
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv("AUTOLABOS_FAKE_OLLAMA_RESPONSE", ORIGINAL_FAKE_RESPONSE);
  restoreEnv("AUTOLABOS_FAKE_OLLAMA_RESPONSE_SEQUENCE", ORIGINAL_FAKE_SEQUENCE);
});

describe("dynamic Ollama model catalog", () => {
  it("returns no choices when neither installed nor configured models exist", () => {
    expect(buildOllamaModelChoices()).toEqual([]);
  });

  it("normalizes, deduplicates, and sorts installed model names", () => {
    expect(normalizeOllamaModelNames([
      ` ${RESEARCH_MODEL} `,
      CHAT_MODEL,
      RESEARCH_MODEL,
      ""
    ])).toEqual([CHAT_MODEL, RESEARCH_MODEL]);
  });

  it("keeps an explicit configured model first without inventing recommendations", () => {
    const configured = "configured-local-model:latest";
    expect(buildOllamaModelChoices([RESEARCH_MODEL, CHAT_MODEL], configured)).toEqual([
      configured,
      CHAT_MODEL,
      RESEARCH_MODEL
    ]);
    expect(buildOllamaModelOptions([CHAT_MODEL], configured)[0]).toMatchObject({
      value: configured,
      description: expect.stringContaining("not reported")
    });
  });

  it("requires every role and reports the missing roles", () => {
    expect(getMissingOllamaModelRoles({ chat: CHAT_MODEL })).toEqual([
      "research",
      "experiment",
      "vision"
    ]);
    expect(() => requireOllamaModel("", "vision")).toThrow(OllamaModelConfigurationError);
    expect(requireOllamaModel(` ${VISION_MODEL} `, "vision")).toBe(VISION_MODEL);
  });
});

describe("Ollama config compatibility", () => {
  it("leaves Ollama absent for a non-Ollama config", async () => {
    const { paths } = await createWorkspace();
    const loaded = await loadConfig(paths);
    expect(loaded.providers.ollama).toBeUndefined();
    expect(loaded.research).toEqual({
      default_topic: "",
      default_constraints: [],
      default_objective_metric: ""
    });
  });

  it("round-trips all explicit role models unchanged", async () => {
    const config = makeOllamaConfig();
    config.providers.ollama!.base_url = "http://local-host:11434";
    const { paths } = await createWorkspace(config);
    const loaded = await loadConfig(paths);
    expect(loaded.providers.ollama).toEqual(config.providers.ollama);
  });

  it("keeps new or incomplete Ollama settings unconfigured instead of filling static models", async () => {
    const config = makeBaseConfig();
    config.providers.llm_mode = "ollama";
    config.providers.ollama = { base_url: "", chat_model: "", research_model: "" };
    const { paths } = await createWorkspace(config);
    const loaded = await loadConfig(paths);
    expect(loaded.providers.ollama).toEqual({
      base_url: DEFAULT_OLLAMA_BASE_URL,
      chat_model: "",
      research_model: "",
      experiment_model: "",
      vision_model: ""
    });
  });

  it("preserves an explicit research model as the missing experiment role fallback", async () => {
    const config = makeBaseConfig();
    config.providers.llm_mode = "ollama";
    config.providers.ollama = {
      base_url: DEFAULT_OLLAMA_BASE_URL,
      chat_model: CHAT_MODEL,
      research_model: RESEARCH_MODEL
    };
    const { paths } = await createWorkspace(config);
    const loaded = await loadConfig(paths);
    expect(loaded.providers.ollama?.research_model).toBe(RESEARCH_MODEL);
    expect(loaded.providers.ollama?.experiment_model).toBe(RESEARCH_MODEL);
    expect(loaded.providers.ollama?.vision_model).toBe("");
  });
});

describe("Ollama setup", () => {
  it("uses live discovery choices while requiring explicit role answers", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-setup-ollama-"));
    const paths = resolveAppPaths(cwd);
    const discoverOllamaModels = vi.fn().mockResolvedValue([
      RESEARCH_MODEL,
      CHAT_MODEL,
      RESEARCH_MODEL,
      EXPERIMENT_MODEL,
      VISION_MODEL
    ]);

    const config = await runSetupWizard(
      paths,
      makePromptReaderFromQuestionMap({
        "Primary LLM provider": "ollama",
        "Ollama base URL": "",
        "Chat model": CHAT_MODEL,
        "Research backend model": RESEARCH_MODEL,
        "Experiment/code model": EXPERIMENT_MODEL,
        "Vision/PDF model": VISION_MODEL
      }),
      { discoverOllamaModels }
    );

    expect(discoverOllamaModels).toHaveBeenCalledWith(DEFAULT_OLLAMA_BASE_URL);
    expect(config.providers.ollama).toEqual({
      base_url: DEFAULT_OLLAMA_BASE_URL,
      chat_model: CHAT_MODEL,
      research_model: RESEARCH_MODEL,
      experiment_model: EXPERIMENT_MODEL,
      vision_model: VISION_MODEL
    });
    expect(config.research).toEqual({
      default_topic: "",
      default_constraints: [],
      default_objective_metric: ""
    });
  });

  it("falls back to required manual input when discovery is unreachable", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-setup-ollama-error-"));
    const paths = resolveAppPaths(cwd);
    const output: string[] = [];
    const config = await runSetupWizard(
      paths,
      makePromptReaderFromQuestionMap({
        "Primary LLM provider": "ollama",
        "Ollama base URL": "",
        "Chat model": CHAT_MODEL,
        "Research backend model": RESEARCH_MODEL,
        "Experiment/code model": EXPERIMENT_MODEL,
        "Vision/PDF model": VISION_MODEL
      }),
      {
        discoverOllamaModels: vi.fn().mockRejectedValue(new Error("connection refused")),
        outputWriter: { write: (message: string) => { output.push(message); return true; } }
      }
    );

    expect(config.providers.ollama?.chat_model).toBe(CHAT_MODEL);
    expect(output.join("")).toContain("Could not reach Ollama");
    expect(output.join("")).toContain("Enter an installed model identifier");
  });

  it("rejects incomplete non-interactive Ollama settings", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-setup-incomplete-"));
    await expect(runNonInteractiveSetup(resolveAppPaths(cwd), {
      llmMode: "ollama",
      semanticScholarApiKey: "test-key",
      ollamaChatModel: CHAT_MODEL
    })).rejects.toThrow("research, experiment, vision");
  });

  it("persists complete non-interactive Ollama settings", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-setup-complete-"));
    const config = await runNonInteractiveSetup(resolveAppPaths(cwd), {
      llmMode: "ollama",
      semanticScholarApiKey: "test-key",
      ollamaChatModel: CHAT_MODEL,
      ollamaResearchModel: RESEARCH_MODEL,
      ollamaExperimentModel: EXPERIMENT_MODEL,
      ollamaVisionModel: VISION_MODEL
    });
    expect(config.providers.ollama?.chat_model).toBe(CHAT_MODEL);
    expect(getDefaultPdfAnalysisModeForLlmMode(config.providers.llm_mode)).toBe("ollama_vision");
  });
});

describe("OllamaClient", () => {
  it("normalizes a base URL and discovers installed models from /api/tags", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      models: [
        { name: ` ${RESEARCH_MODEL} `, size: 2 },
        { name: CHAT_MODEL, size: 1 },
        { name: RESEARCH_MODEL, size: 3 },
        { name: "", size: 4 }
      ]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const client = new OllamaClient("http://local-host:11434///");
    const models = await client.listModels();

    expect(client.getBaseUrl()).toBe("http://local-host:11434");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://local-host:11434/api/tags");
    expect(models.map((model) => model.name)).toEqual([CHAT_MODEL, RESEARCH_MODEL]);
  });

  it("rejects a blank model before issuing a chat request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const client = new OllamaClient();
    await expect(client.chat({
      model: "  ",
      messages: [{ role: "user", content: "hello" }]
    })).rejects.toThrow("not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a neutral fake response for an explicitly configured model", async () => {
    process.env.AUTOLABOS_FAKE_OLLAMA_RESPONSE = "local response";
    const result = await new OllamaClient().chat({
      model: CHAT_MODEL,
      messages: [{ role: "user", content: "hello" }]
    });
    expect(result).toMatchObject({ text: "local response", model: CHAT_MODEL });
  });
});

describe("web Ollama discovery", () => {
  it("returns installed models in a reachable response", async () => {
    const createClient = vi.fn(() => ({
      listModels: vi.fn().mockResolvedValue([
        { name: CHAT_MODEL, size: 1, digest: "a", modified_at: "now" },
        { name: RESEARCH_MODEL, size: 2, digest: "b", modified_at: "now" }
      ])
    }));

    await expect(discoverOllamaModels("http://local-host:11434", createClient)).resolves.toEqual({
      baseUrl: "http://local-host:11434",
      reachable: true,
      models: [CHAT_MODEL, RESEARCH_MODEL]
    });
    expect(createClient).toHaveBeenCalledWith("http://local-host:11434");
  });

  it("returns a fail-closed response when the server is unreachable", async () => {
    const createClient = () => ({
      listModels: vi.fn().mockRejectedValue(new Error("connection refused"))
    });

    await expect(discoverOllamaModels("", createClient)).resolves.toEqual({
      baseUrl: DEFAULT_OLLAMA_BASE_URL,
      reachable: false,
      models: [],
      error: "connection refused"
    });
  });
});

describe("Ollama LLM and vision role clients", () => {
  it("fails closed when the LLM wrapper has no configured model", async () => {
    const llm = new OllamaLLMClient(new OllamaClient());
    await expect(llm.complete("hello")).rejects.toThrow("not configured");
  });

  it("routes an explicitly configured local model without touching other providers", async () => {
    process.env.AUTOLABOS_FAKE_OLLAMA_RESPONSE = "local output";
    const local = new OllamaLLMClient(new OllamaClient(), { model: RESEARCH_MODEL });
    const routed = new RoutedLLMClient(() => local);
    await expect(routed.complete("research task")).resolves.toMatchObject({ text: "local output" });
  });

  it("resolves the vision model and client at call time", async () => {
    process.env.AUTOLABOS_FAKE_OLLAMA_RESPONSE = "page evidence";
    const imageDir = await fs.mkdtemp(path.join(os.tmpdir(), "autolabos-vision-"));
    const imagePath = path.join(imageDir, "page.png");
    await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const createClient = vi.fn(() => new OllamaClient());
    const resolveModel = vi.fn(() => VISION_MODEL);
    const pdf = new OllamaPdfAnalysisClient(createClient, resolveModel);

    const result = await pdf.analyzePageImage({ imagePath, prompt: "extract evidence" });

    expect(createClient).toHaveBeenCalledOnce();
    expect(resolveModel).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ text: "page evidence", model: VISION_MODEL, pagesAnalyzed: 1 });
  });
});

describe("public Ollama source hygiene", () => {
  it("contains no concrete public Ollama model family identifiers", async () => {
    const files = [
      "src/integrations/ollama/modelCatalog.ts",
      "src/integrations/ollama/ollamaClient.ts",
      "src/integrations/ollama/ollamaPdfAnalysisClient.ts",
      "src/config.ts",
      "src/runtime/createRuntime.ts",
      "src/tui/TerminalApp.ts",
      "src/interaction/InteractionSession.ts",
      "src/web/server.ts",
      "web/src/App.tsx",
      "src/core/llm/modelPricing.ts",
      "src/core/llm/client.ts",
      "src/core/experimentLlmProfile.ts"
    ];
    const contents = await Promise.all(files.map((file) => fs.readFile(file, "utf8")));
    const publicRuntimeText = contents
      .join("\n")
      .split("\n")
      .filter((line) => !/^import\b/u.test(line) && !/\bfrom\s+["']/u.test(line))
      .join("\n");
    expect(publicRuntimeText).not.toMatch(/["'][a-z0-9][a-z0-9_.-]*:[a-z0-9][a-z0-9_.-]*["']/iu);
  });
});
