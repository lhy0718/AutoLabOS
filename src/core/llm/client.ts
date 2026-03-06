import { CodexCliClient } from "../../integrations/codex/codexCliClient.js";

export interface LLMCompletionUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface LLMCompletion {
  text: string;
  usage?: LLMCompletionUsage;
}

export interface LLMClient {
  complete(prompt: string, opts?: { threadId?: string; systemPrompt?: string }): Promise<LLMCompletion>;
}

export class CodexLLMClient implements LLMClient {
  constructor(private readonly codex: CodexCliClient) {}

  async complete(prompt: string, opts?: { threadId?: string; systemPrompt?: string }): Promise<LLMCompletion> {
    const result = await this.codex.runTurnStream({
      prompt,
      threadId: opts?.threadId,
      systemPrompt: opts?.systemPrompt,
      sandboxMode: "read-only",
      approvalPolicy: "never"
    });

    return {
      text: result.finalText,
      usage: {
        costUsd: undefined
      }
    };
  }
}

export class MockLLMClient implements LLMClient {
  async complete(prompt: string): Promise<LLMCompletion> {
    return {
      text: `[mock] ${prompt.slice(0, 120)}`,
      usage: {
        inputTokens: prompt.length / 4,
        outputTokens: 32,
        costUsd: 0
      }
    };
  }
}
