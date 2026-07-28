import {
  CodexNativeClient,
  extractCodexCompletionUsageFromEvents
} from "../../integrations/codex/codexCliClient.js";
import { CodexOAuthResponsesTextClient } from "../../integrations/codex/oauthResponsesTextClient.js";
import { OpenAiResponsesTextClient } from "../../integrations/openai/responsesTextClient.js";
import { OllamaClient } from "../../integrations/ollama/ollamaClient.js";
import { computeModelUsageCostUsd } from "./modelPricing.js";

export interface LLMCompletionUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface LLMCompletionProvenance {
  provider: "codex" | "openai" | "ollama" | "mock";
  requestedModel: string;
  effectiveModel: string;
  reasoningEffort: string;
  responseId?: string;
  contextMode: "fresh" | "continued" | "stateless";
  identityBasis: "provider_response" | "adapter_request" | "mock";
}

export interface LLMCompletion {
  text: string;
  threadId?: string;
  usage?: LLMCompletionUsage;
  provenance?: LLMCompletionProvenance;
}

export interface LLMProgressEvent {
  type: "status" | "delta";
  text: string;
}

export interface LLMCompleteOptions {
  threadId?: string;
  systemPrompt?: string;
  inputImagePaths?: string[];
  model?: string;
  reasoningEffort?: string;
  onProgress?: (event: LLMProgressEvent) => void;
  abortSignal?: AbortSignal;
}

export interface LLMClient {
  complete(prompt: string, opts?: LLMCompleteOptions): Promise<LLMCompletion>;
}

interface CodexClientDefaults {
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
}

export class CodexNativeLLMClient implements LLMClient {
  constructor(
    private readonly codex: CodexNativeClient,
    private readonly defaults: CodexClientDefaults = {}
  ) {}

  async complete(
    prompt: string,
    opts?: LLMCompleteOptions
  ): Promise<LLMCompletion> {
    const progress = createCodexProgressEmitter(opts?.onProgress);
    const result = await this.codex.runTurnStream({
      prompt,
      threadId: opts?.threadId,
      systemPrompt: opts?.systemPrompt,
      inputImagePaths: opts?.inputImagePaths,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      model: opts?.model || this.defaults.model,
      reasoningEffort: (opts?.reasoningEffort || this.defaults.reasoningEffort) as never,
      fastMode: this.defaults.fastMode,
      abortSignal: opts?.abortSignal,
      onEvent: (event) => {
        progress?.onEvent(event);
      }
    });
    progress?.flush();

    const codexUsage = extractCodexCompletionUsageFromEvents(result.events);
    const requestedModel = opts?.model || this.defaults.model || "";
    const resolvedModel = codexUsage?.model || requestedModel;
    const reasoningEffort = opts?.reasoningEffort || this.defaults.reasoningEffort || "default";

    return {
      text: result.finalText,
      threadId: result.threadId,
      usage: {
        inputTokens: codexUsage?.inputTokens,
        outputTokens: codexUsage?.outputTokens,
        costUsd: computeModelUsageCostUsd(resolvedModel, {
          inputTokens: codexUsage?.inputTokens,
          outputTokens: codexUsage?.outputTokens
        })
      },
      provenance: {
        provider: "codex",
        requestedModel,
        effectiveModel: resolvedModel,
        reasoningEffort,
        responseId: result.threadId,
        contextMode: opts?.threadId ? "continued" : "fresh",
        identityBasis: codexUsage?.model ? "provider_response" : "adapter_request"
      }
    };
  }
}


export class OpenAiResponsesLLMClient implements LLMClient {
  constructor(
    private readonly openai: OpenAiResponsesTextClient,
    private readonly defaults: { model?: string; reasoningEffort?: string; background?: boolean } = {}
  ) {}

  async complete(
    prompt: string,
    opts?: LLMCompleteOptions
  ): Promise<LLMCompletion> {
    const requestedModel = opts?.model || this.defaults.model || "";
    const reasoningEffort = opts?.reasoningEffort || this.defaults.reasoningEffort || "default";
    opts?.onProgress?.({ type: "status", text: "Submitting request to OpenAI Responses API." });
    const result = await this.openai.complete({
      prompt,
      threadId: opts?.threadId,
      systemPrompt: opts?.systemPrompt,
      model: requestedModel,
      reasoningEffort,
      background: this.defaults.background,
      abortSignal: opts?.abortSignal,
      onProgress: (message) => {
        opts?.onProgress?.({ type: "status", text: message });
      }
    });
    opts?.onProgress?.({ type: "status", text: "Received Responses API output." });

    return {
      text: result.text,
      threadId: result.responseId || this.openai.lastResponseId(),
      usage: result.usage,
      provenance: {
        provider: "openai",
        requestedModel,
        effectiveModel: result.model || requestedModel,
        reasoningEffort,
        responseId: result.responseId || this.openai.lastResponseId(),
        contextMode: opts?.threadId ? "continued" : "fresh",
        identityBasis: result.model ? "provider_response" : "adapter_request"
      }
    };
  }
}

export class CodexOAuthResponsesLLMClient implements LLMClient {
  constructor(
    private readonly codexOAuth: CodexOAuthResponsesTextClient,
    private readonly defaults: { model?: string; reasoningEffort?: string } = {}
  ) {}

  async complete(
    prompt: string,
    opts?: LLMCompleteOptions
  ): Promise<LLMCompletion> {
    const requestedModel = opts?.model || this.defaults.model || "";
    const reasoningEffort = opts?.reasoningEffort || this.defaults.reasoningEffort || "default";
    opts?.onProgress?.({ type: "status", text: "Submitting request to Codex OAuth backend." });
    const result = await this.codexOAuth.complete({
      prompt,
      threadId: opts?.threadId,
      systemPrompt: opts?.systemPrompt,
      inputImagePaths: opts?.inputImagePaths,
      model: requestedModel,
      reasoningEffort,
      abortSignal: opts?.abortSignal,
      onProgress: (event) => {
        opts?.onProgress?.(event);
      }
    });

    return {
      text: result.text,
      threadId: result.responseId || this.codexOAuth.lastResponseId(),
      usage: result.usage,
      provenance: {
        provider: "codex",
        requestedModel,
        effectiveModel: result.model || requestedModel,
        reasoningEffort,
        responseId: result.responseId || this.codexOAuth.lastResponseId(),
        contextMode: opts?.threadId ? "continued" : "fresh",
        identityBasis: result.model ? "provider_response" : "adapter_request"
      }
    };
  }
}

interface OllamaClientDefaults {
  model?: string;
}

export class OllamaLLMClient implements LLMClient {
  constructor(
    private readonly ollama: OllamaClient,
    private readonly defaults: OllamaClientDefaults = {}
  ) {}

  async complete(
    prompt: string,
    opts?: LLMCompleteOptions
  ): Promise<LLMCompletion> {
    const model = (opts?.model || this.defaults.model || "").trim();
    if (!model) {
      throw new Error(
        "Ollama model is not configured. Select an installed model or enter a model identifier before continuing."
      );
    }
    opts?.onProgress?.({ type: "status", text: `Submitting request to Ollama (${model}).` });

    const hasImages = opts?.inputImagePaths && opts.inputImagePaths.length > 0;

    // Use streaming for text-only requests with a progress callback to provide live feedback.
    // Image requests and calls without onProgress use non-streaming for stability.
    const useStream = !hasImages && Boolean(opts?.onProgress);

    const result = hasImages
      ? await this.ollama.chatWithImages({
          model,
          prompt,
          systemPrompt: opts?.systemPrompt,
          imagePaths: opts!.inputImagePaths!,
          abortSignal: opts?.abortSignal
        })
      : useStream
        ? await this.ollama.chatStream({
            model,
            messages: [
              ...(opts?.systemPrompt ? [{ role: "system" as const, content: opts.systemPrompt }] : []),
              { role: "user" as const, content: prompt }
            ],
            abortSignal: opts?.abortSignal,
            onToken: createOllamaStreamEmitter(opts?.onProgress)
          })
        : await this.ollama.chat({
            model,
            messages: [
              ...(opts?.systemPrompt ? [{ role: "system" as const, content: opts.systemPrompt }] : []),
              { role: "user" as const, content: prompt }
            ],
            abortSignal: opts?.abortSignal
          });

    opts?.onProgress?.({ type: "status", text: "Received Ollama output." });

    return {
      text: result.text,
      usage: {
        inputTokens: result.promptEvalCount,
        outputTokens: result.evalCount,
        costUsd: 0
      },
      provenance: {
        provider: "ollama",
        requestedModel: model,
        effectiveModel: model,
        reasoningEffort: opts?.reasoningEffort || "default",
        contextMode: "stateless",
        identityBasis: "adapter_request"
      }
    };
  }
}

export class RoutedLLMClient implements LLMClient {
  constructor(private readonly resolveClient: () => LLMClient) {}

  async complete(
    prompt: string,
    opts?: LLMCompleteOptions
  ): Promise<LLMCompletion> {
    return this.resolveClient().complete(prompt, opts);
  }
}

export class MockLLMClient implements LLMClient {
  async complete(prompt: string, opts?: LLMCompleteOptions): Promise<LLMCompletion> {
    return {
      text: `[mock] ${prompt.slice(0, 120)}`,
      usage: {
        inputTokens: prompt.length / 4,
        outputTokens: 32,
        costUsd: 0
      },
      provenance: {
        provider: "mock",
        requestedModel: opts?.model || "mock",
        effectiveModel: "mock",
        reasoningEffort: opts?.reasoningEffort || "mock",
        contextMode: "stateless",
        identityBasis: "mock"
      }
    };
  }
}

function createCodexProgressEmitter(
  onProgress?: (event: LLMProgressEvent) => void
): { onEvent: (event: Record<string, unknown>) => void; flush: () => void } | undefined {
  if (!onProgress) {
    return undefined;
  }

  const state = {
    buffer: "",
    lastEmitMs: 0
  };

  const flush = () => {
    const text = oneLine(state.buffer);
    if (!text) {
      state.buffer = "";
      return;
    }
    onProgress({ type: "delta", text });
    state.buffer = "";
    state.lastEmitMs = Date.now();
  };

  return {
    onEvent(event: Record<string, unknown>) {
      const type = typeof event.type === "string" ? event.type : "";
      if (type === "thread.started") {
        onProgress({ type: "status", text: "Codex analysis session started." });
        return;
      }
      const delta = extractProgressDelta(event);
      if (delta) {
        state.buffer += delta;
        const now = Date.now();
        const hasBreak = /[\n\r]/u.test(state.buffer);
        const longEnough = state.buffer.length >= 48;
        if (state.lastEmitMs === 0) {
          state.lastEmitMs = now;
        }
        const stale = now - state.lastEmitMs >= 500;
        if (hasBreak || longEnough || stale) {
          flush();
        }
        return;
      }
      if (type.endsWith(".completed") || type === "response.completed" || type === "item.completed") {
        flush();
      }
    },
    flush
  };
}

function extractProgressDelta(event: Record<string, unknown>): string {
  const type = typeof event.type === "string" ? event.type : "";
  if (!type.includes("delta")) {
    return "";
  }
  const direct =
    (typeof event.delta === "string" ? event.delta : "") ||
    (typeof event.text === "string" ? event.text : "") ||
    extractTextFromUnknown(event.item) ||
    extractTextFromUnknown(event.content);
  return direct;
}

function extractTextFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => extractTextFromUnknown(item)).join("");
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  const direct =
    (typeof record.text === "string" ? record.text : "") ||
    (typeof record.output_text === "string" ? record.output_text : "") ||
    (typeof record.delta === "string" ? record.delta : "");
  if (direct) {
    return direct;
  }
  return extractTextFromUnknown(record.content);
}

function createOllamaStreamEmitter(
  onProgress?: (event: LLMProgressEvent) => void
): ((token: string) => void) | undefined {
  if (!onProgress) return undefined;
  let buffer = "";
  let lastEmitMs = 0;
  return (token: string) => {
    buffer += token;
    const now = Date.now();
    if (lastEmitMs === 0) lastEmitMs = now;
    const hasBreak = /[\n\r]/u.test(buffer);
    const longEnough = buffer.length >= 48;
    const stale = now - lastEmitMs >= 500;
    if (hasBreak || longEnough || stale) {
      const text = buffer.replace(/\s+/g, " ").trim().slice(0, 220);
      if (text) {
        onProgress({ type: "delta", text });
      }
      buffer = "";
      lastEmitMs = now;
    }
  };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 220);
}
