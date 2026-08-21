import { afterEach, describe, expect, it, vi } from "vitest";

import { CodexOAuthResponsesLLMClient } from "../src/core/llm/client.js";
import { CodexOAuthCompletionError } from "../src/integrations/codex/oauthCompletionError.js";
import { CodexOAuthResponsesTextClient } from "../src/integrations/codex/oauthResponsesTextClient.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject.");
}

describe("CodexOAuthResponsesTextClient", () => {
  it("does not call the backend when the compatibility probe lacks account binding", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token"
    }));

    await expect(client.probeCompatibility({ model: "configured-chat-model" })).resolves.toEqual({
      status: "auth_unavailable"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs one fixed compatibility probe without returning output or mutating response state", async () => {
    const configuredModel = " configured-chat-model ";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(_url).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer test-access-token",
        "ChatGPT-Account-ID": "acct_123",
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      });
      expect(JSON.parse(String(init?.body || "{}"))).toEqual({
        model: configuredModel,
        instructions: "Return exactly OK.",
        store: false,
        stream: true,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "Return exactly OK." }]
          }
        ],
        text: { format: { type: "text" } },
        reasoning: { effort: "low" }
      });
      return new Response(
        [
          "event: response.completed",
          'data: {"type":"response.completed","response":{"id":"private-response-id","model":"configured-chat-model","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"private-provider-output"}]}]}}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));
    (client as unknown as { mostRecentResponseId?: string }).mostRecentResponseId = "existing-response-id";

    const result = await client.probeCompatibility({ model: configuredModel });

    expect(result).toEqual({ status: "compatible" });
    expect(JSON.stringify(result)).not.toContain("private-provider-output");
    expect(JSON.stringify(result)).not.toContain("private-response-id");
    expect(client.lastResponseId()).toBe("existing-response-id");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "item.completed",
      [
        "event: item.completed",
        'data: {"type":"item.completed","item":{"type":"message","content":[{"type":"output_text","text":"bounded compatibility output"}]}}',
        ""
      ].join("\n")
    ],
    [
      "response.output_text.done",
      [
        "event: response.output_text.done",
        'data: {"type":"response.output_text.done","text":"bounded compatibility output"}',
        ""
      ].join("\n")
    ],
    [
      "message.completed",
      [
        "event: message.completed",
        'data: {"type":"message.completed","content":[{"type":"output_text","text":"bounded compatibility output"}]}',
        ""
      ].join("\n")
    ]
  ])("preserves %s as a compatible success terminal", async (_eventType, streamBody) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(streamBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      }))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));

    await expect(client.probeCompatibility({ model: "configured-chat-model" })).resolves.toEqual({
      status: "compatible"
    });
  });

  it("accepts a standard response.output_item.done probe without committing its response id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.created",
          'data: {"type":"response.created","response":{"id":"private-output-item-probe-id","status":"in_progress"}}',
          "",
          "event: response.output_item.done",
          'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"message-item-id","status":"completed","type":"message","role":"assistant","content":[{"type":"output_text","text":"bounded compatibility output","annotations":[]}]},"sequence_number":1}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));
    (client as unknown as { mostRecentResponseId?: string }).mostRecentResponseId = "existing-response-id";

    const result = await client.probeCompatibility({ model: "configured-chat-model" });

    expect(result).toEqual({ status: "compatible" });
    expect(JSON.stringify(result)).not.toContain("bounded compatibility output");
    expect(JSON.stringify(result)).not.toContain("private-output-item-probe-id");
    expect(client.lastResponseId()).toBe("existing-response-id");
  });

  it.each([
    ["response.completed", "cancelled"],
    ["response.completed", "canceled"],
    ["response.cancelled", "completed"],
    ["response.canceled", "completed"]
  ] as const)(
    "does not report compatibility for a %s frame with %s cancellation state",
    async (eventType, status) => {
      const partialOutput = "cancelled-probe-partial-output";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(
          [
            `event: ${eventType}`,
            `data: {"type":"${eventType}","response":{"id":"discarded-probe-id","status":"${status}","output":[{"type":"message","content":[{"type":"output_text","text":"${partialOutput}"}]}]}}`,
            ""
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        ))
      );
      const client = new CodexOAuthResponsesTextClient(async () => ({
        accessToken: "test-access-token",
        accountId: "acct_123"
      }));
      (client as unknown as { mostRecentResponseId?: string }).mostRecentResponseId = "existing-response-id";

      const result = await client.probeCompatibility({ model: "configured-chat-model" });

      expect(result).toEqual({ status: "provider_error" });
      expect(JSON.stringify(result)).not.toContain(partialOutput);
      expect(JSON.stringify(result)).not.toContain("discarded-probe-id");
      expect(client.lastResponseId()).toBe("existing-response-id");
    }
  );

  it("does not report compatibility when a delta-only probe stream ends without a success terminal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.created",
          'data: {"type":"response.created","response":{"id":"uncommitted-probe-id","status":"in_progress"}}',
          "",
          "event: response.output_text.delta",
          'data: {"type":"response.output_text.delta","delta":"partial probe output"}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));
    (client as unknown as { mostRecentResponseId?: string }).mostRecentResponseId = "existing-response-id";

    const result = await client.probeCompatibility({ model: "configured-chat-model" });

    expect(result).toEqual({ status: "provider_error" });
    expect(JSON.stringify(result)).not.toContain("partial probe output");
    expect(JSON.stringify(result)).not.toContain("uncommitted-probe-id");
    expect(client.lastResponseId()).toBe("existing-response-id");
  });

  it("does not treat reasoning-summary completion as a compatible output terminal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.created",
          'data: {"type":"response.created","response":{"id":"uncommitted-probe-id","status":"in_progress"}}',
          "",
          "event: response.output_text.delta",
          'data: {"type":"response.output_text.delta","delta":"partial probe output"}',
          "",
          "event: response.reasoning_summary_text.done",
          'data: {"type":"response.reasoning_summary_text.done","text":"reasoning summary only"}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));

    const result = await client.probeCompatibility({ model: "configured-chat-model" });

    expect(result).toEqual({ status: "provider_error" });
    expect(JSON.stringify(result)).not.toContain("partial probe output");
    expect(JSON.stringify(result)).not.toContain("reasoning summary only");
  });

  it("does not treat a reasoning-only delta plus an empty response completion as compatible", async () => {
    const reasoningCanary = "reasoning-only-probe-delta";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.created",
          'data: {"type":"response.created","response":{"id":"uncommitted-probe-id","status":"in_progress"}}',
          "",
          "event: response.reasoning_summary_text.delta",
          `data: {"type":"response.reasoning_summary_text.delta","delta":"${reasoningCanary}"}`,
          "",
          "event: response.completed",
          'data: {"type":"response.completed","response":{"id":"uncommitted-probe-id","status":"completed","output":[]}}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));
    (client as unknown as { mostRecentResponseId?: string }).mostRecentResponseId = "existing-response-id";

    const result = await client.probeCompatibility({ model: "configured-chat-model" });

    expect(result).toEqual({ status: "empty_response" });
    expect(JSON.stringify(result)).not.toContain(reasoningCanary);
    expect(JSON.stringify(result)).not.toContain("uncommitted-probe-id");
    expect(client.lastResponseId()).toBe("existing-response-id");
  });

  it("does not use a pre-terminal response snapshot to make an empty probe compatible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.created",
          'data: {"type":"response.created","response":{"id":"uncommitted-probe-id","status":"in_progress","output":[{"type":"message","content":[{"type":"output_text","text":"stale response snapshot"}]}]}}',
          "",
          "event: response.completed",
          'data: {"type":"response.completed","response":{"id":"uncommitted-probe-id","status":"completed","output":[]}}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));

    await expect(client.probeCompatibility({ model: "configured-chat-model" })).resolves.toEqual({
      status: "empty_response"
    });
  });

  it("keeps a probe compatible when a real final response follows a reasoning delta", async () => {
    const reasoningCanary = "long-reasoning-probe-delta-that-must-not-be-used-as-output";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.reasoning_summary_text.delta",
          `data: {"type":"response.reasoning_summary_text.delta","delta":"${reasoningCanary}"}`,
          "",
          "event: response.completed",
          'data: {"type":"response.completed","response":{"id":"private-final-probe-id","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"final"}]}]}}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));
    (client as unknown as { mostRecentResponseId?: string }).mostRecentResponseId = "existing-response-id";

    const result = await client.probeCompatibility({ model: "configured-chat-model" });

    expect(result).toEqual({ status: "compatible" });
    expect(JSON.stringify(result)).not.toContain(reasoningCanary);
    expect(JSON.stringify(result)).not.toContain("private-final-probe-id");
    expect(client.lastResponseId()).toBe("existing-response-id");
  });

  it.each([
    ["reasoning item", '{"type":"reasoning","summary":[{"type":"summary_text","text":"reasoning only"}]}'],
    ["empty item", "{}"],
    [
      "message item without output_text content",
      '{"type":"message","content":[{"type":"reasoning_text","text":"non-output message text"}]}'
    ],
    [
      "message item with empty output_text content",
      '{"type":"message","content":[{"type":"output_text","text":""}]}'
    ]
  ])("does not treat item.completed with a %s as a compatible output terminal", async (_label, itemJson) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.created",
          'data: {"type":"response.created","response":{"id":"uncommitted-probe-id","status":"in_progress"}}',
          "",
          "event: response.output_text.delta",
          'data: {"type":"response.output_text.delta","delta":"partial probe output"}',
          "",
          "event: item.completed",
          `data: {"type":"item.completed","item":${itemJson}}`,
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));

    const result = await client.probeCompatibility({ model: "configured-chat-model" });

    expect(result).toEqual({ status: "provider_error" });
    expect(JSON.stringify(result)).not.toContain("partial probe output");
    expect(JSON.stringify(result)).not.toContain("uncommitted-probe-id");
  });

  it.each([
    ["reasoning item", '{"type":"reasoning","summary":[{"type":"summary_text","text":"reasoning only"}]}'],
    ["empty item", "{}"],
    ["non-message output_text item", '{"type":"output_text","text":"misplaced output text"}'],
    [
      "message item without output_text content",
      '{"type":"message","content":[{"type":"reasoning_text","text":"non-output message text"}]}'
    ],
    [
      "message item with empty output_text content",
      '{"type":"message","content":[{"type":"output_text","text":""}]}'
    ],
    [
      "incomplete message item",
      '{"type":"message","status":"incomplete","content":[{"type":"output_text","text":"uncommitted output"}]}'
    ],
    [
      "in-progress message item",
      '{"type":"message","status":"in_progress","content":[{"type":"output_text","text":"uncommitted output"}]}'
    ]
  ])(
    "does not treat response.output_item.done with a %s as a compatible output terminal",
    async (_label, itemJson) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(
          [
            "event: response.created",
            'data: {"type":"response.created","response":{"id":"uncommitted-output-item-probe-id","status":"in_progress"}}',
            "",
            "event: response.output_text.delta",
            'data: {"type":"response.output_text.delta","delta":"partial probe output"}',
            "",
            "event: response.output_item.done",
            `data: {"type":"response.output_item.done","output_index":0,"item":${itemJson},"sequence_number":1}`,
            ""
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        ))
      );
      const client = new CodexOAuthResponsesTextClient(async () => ({
        accessToken: "test-access-token",
        accountId: "acct_123"
      }));
      (client as unknown as { mostRecentResponseId?: string }).mostRecentResponseId = "existing-response-id";

      const result = await client.probeCompatibility({ model: "configured-chat-model" });

      expect(result).toEqual({ status: "provider_error" });
      expect(JSON.stringify(result)).not.toContain("partial probe output");
      expect(JSON.stringify(result)).not.toContain("uncommitted-output-item-probe-id");
      expect(client.lastResponseId()).toBe("existing-response-id");
    }
  );

  it("does not treat an unstructured message.completed frame as compatible output", async () => {
    const nonOutputDetail = "non-output-message-detail";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: message.completed",
          `data: {"type":"message.completed","item":{"type":"reasoning","summary":[]},"message":"${nonOutputDetail}"}`,
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));

    const result = await client.probeCompatibility({ model: "configured-chat-model" });

    expect(result).toEqual({ status: "empty_response" });
    expect(JSON.stringify(result)).not.toContain(nonOutputDetail);
  });

  it.each([
    [401, "auth_unavailable"],
    [403, "auth_unavailable"],
    [400, "request_rejected"],
    [404, "request_rejected"],
    [409, "request_rejected"],
    [422, "request_rejected"],
    [429, "rate_limited"],
    [500, "provider_error"]
  ])("classifies compatibility probe HTTP %s without exposing its body", async (status, expected) => {
    const response = new Response("private-provider-error-body", { status });
    const textSpy = vi.spyOn(response, "text");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response)
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));

    const result = await client.probeCompatibility({ model: "configured-chat-model" });

    expect(result).toEqual({ status: expected });
    expect(JSON.stringify(result)).not.toContain("private-provider-error-body");
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("returns only a bounded provider failure for a streamed private error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.completed",
          'data: {"type":"response.completed","response":{"status":"failed","error":{"message":"private-stream-error"},"output":[]}}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));

    const result = await client.probeCompatibility({ model: "configured-chat-model" });

    expect(result).toEqual({ status: "provider_error" });
    expect(JSON.stringify(result)).not.toContain("private-stream-error");
  });

  it("treats a failed success-status payload as provider failure even when it contains text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.failed",
          'data: {"type":"response.failed","response":{"status":"failed","error":{"message":"private-failure"},"output":[{"type":"message","content":[{"type":"output_text","text":"misleading-output"}]}]}}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));

    const result = await client.probeCompatibility({ model: "configured-chat-model" });

    expect(result).toEqual({ status: "provider_error" });
    expect(JSON.stringify(result)).not.toContain("private-failure");
    expect(JSON.stringify(result)).not.toContain("misleading-output");
  });

  it("cancels an oversized compatibility response without retaining its content", async () => {
    const cancel = vi.fn();
    const oversized = new Uint8Array(300 * 1024);
    oversized.fill(65);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(oversized);
        },
        cancel
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } }))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));

    const result = await client.probeCompatibility({ model: "configured-chat-model" });

    expect(result).toEqual({ status: "provider_error" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("bounds a stalled compatibility probe without retrying", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("private-abort-detail");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));

    const probe = client.probeCompatibility({ model: "configured-chat-model", timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);

    await expect(probe).resolves.toEqual({ status: "timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels a stalled response stream when the compatibility timeout expires", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetchMock = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      cancel
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));

    const probe = client.probeCompatibility({ model: "configured-chat-model", timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);

    await expect(probe).resolves.toEqual({ status: "timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("propagates an external compatibility-probe abort", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("provider stream stopped");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));
    const controller = new AbortController();
    const probe = client.probeCompatibility({
      model: "configured-chat-model",
      abortSignal: controller.signal
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(probe).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails clearly when ~/.codex/auth.json credentials are unavailable", async () => {
    const client = new CodexOAuthResponsesTextClient(async () => undefined, { model: "gpt-5.3-codex" });

    await expect(client.runForText({ prompt: "hello" })).rejects.toMatchObject({
      name: "CodexOAuthCompletionError",
      code: "auth_unavailable",
      retryDisposition: "operator_action",
      retryable: false
    });
  });

  it("sanitizes credential resolver failures before they reach completion callers", async () => {
    const client = new CodexOAuthResponsesTextClient(async () => {
      throw new Error("sensitive-credential-detail");
    });

    const error = await captureRejection(client.complete({ prompt: "hello" }));

    expect(error).toMatchObject({ code: "auth_unavailable" });
    expect(`${String(error)}\n${JSON.stringify(error)}`).not.toContain("sensitive-credential-detail");
  });

  it("sanitizes local input preparation failures before contacting the provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "fixture-account"
    }));

    const error = await captureRejection(client.complete({
      prompt: "hello",
      inputImagePaths: ["sensitive-missing-input-path"]
    }));

    expect(error).toMatchObject({
      code: "input_unavailable",
      retryDisposition: "caller_recovery"
    });
    expect(String(error)).not.toContain("sensitive-missing-input-path");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, "sensitive-provider-detail", "auth_unavailable", "operator_action"],
    [400, "sensitive-provider-detail", "request_rejected", "caller_recovery"],
    [429, "sensitive-provider-detail", "rate_limited", "backoff"],
    [
      429,
      JSON.stringify({
        error: {
          type: "usage_limit_reached",
          message: "sensitive-provider-detail"
        }
      }),
      "quota_exhausted",
      "operator_action"
    ],
    [503, "sensitive-provider-detail", "provider_unavailable", "backoff"]
  ])(
    "classifies completion HTTP %s without exposing provider response content",
    async (status, body, expectedCode, expectedDisposition) => {
      const response = new Response(body, { status });
      const textSpy = vi.spyOn(response, "text");
      vi.stubGlobal("fetch", vi.fn(async () => response));
      const client = new CodexOAuthResponsesTextClient(async () => ({
        accessToken: "test-access-token",
        accountId: "acct_123"
      }));
      (client as unknown as { mostRecentResponseId?: string }).mostRecentResponseId = "existing-response-id";

      let thrown: unknown;
      try {
        await client.complete({ prompt: "hello" });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(CodexOAuthCompletionError);
      expect(thrown).toMatchObject({
        code: expectedCode,
        retryDisposition: expectedDisposition
      });
      const exposed = [
        thrown instanceof Error ? thrown.message : String(thrown),
        thrown instanceof Error ? thrown.stack : "",
        JSON.stringify(thrown)
      ].join("\n");
      expect(exposed).not.toContain("sensitive-provider-detail");
      expect(textSpy).not.toHaveBeenCalled();
      expect(client.lastResponseId()).toBe("existing-response-id");
    }
  );

  it("sanitizes streamed provider failures and rejects failed payloads even when they contain text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.failed",
          'data: {"type":"response.failed","response":{"id":"discarded-response-id","status":"failed","error":{"message":"sensitive-stream-detail"},"output":[{"type":"message","content":[{"type":"output_text","text":"misleading-output"}]}]}}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));
    (client as unknown as { mostRecentResponseId?: string }).mostRecentResponseId = "existing-response-id";

    let thrown: unknown;
    try {
      await client.complete({ prompt: "hello" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      name: "CodexOAuthCompletionError",
      code: "provider_error",
      retryDisposition: "none"
    });
    expect(String(thrown)).not.toContain("sensitive-stream-detail");
    expect(String(thrown)).not.toContain("misleading-output");
    expect(String(thrown)).not.toContain("discarded-response-id");
    expect(client.lastResponseId()).toBe("existing-response-id");
  });

  it("bounds and cancels oversized completion error metadata", async () => {
    const cancel = vi.fn();
    const oversized = new Uint8Array(40 * 1024);
    oversized.fill(65);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(oversized);
        },
        cancel
      }), { status: 429 }))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));

    await expect(client.complete({ prompt: "hello" })).rejects.toMatchObject({
      code: "rate_limited"
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("bounds and cancels stalled completion error metadata", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const fetchMock = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      cancel
    }), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));
    const completion = client.complete({ prompt: "hello" });
    const rejection = expect(completion).rejects.toMatchObject({ code: "rate_limited" });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels a stalled completion error body when the operator aborts", async () => {
    const cancel = vi.fn();
    const fetchMock = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      cancel
    }), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));
    const controller = new AbortController();
    const completion = client.complete({ prompt: "hello", abortSignal: controller.signal });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(completion).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not treat a provider-side error-body abort as operator cancellation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new DOMException("sensitive-reader-abort-detail", "AbortError"));
        }
      }), { status: 429 }))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));

    const error = await captureRejection(client.complete({ prompt: "hello" }));

    expect(error).toMatchObject({
      name: "CodexOAuthCompletionError",
      code: "rate_limited"
    });
    expect(String(error)).not.toContain("sensitive-reader-abort-detail");
  });

  it.each([
    [
      "provider termination",
      'data: {"type":"response.failed","response":{"status":"failed","error":{"message":"This operation was aborted"}}}',
      "stream_terminated",
      "This operation was aborted"
    ],
    [
      "provider quota exhaustion",
      'data: {"type":"response.failed","response":{"status":"failed","error":{"type":"usage_limit_reached","message":"sensitive-stream-detail"}}}',
      "quota_exhausted",
      "sensitive-stream-detail"
    ],
    [
      "incomplete response",
      'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"sensitive-incomplete-detail"}}}',
      "incomplete_response",
      "sensitive-incomplete-detail"
    ]
  ])("maps %s to a safe stream category", async (_label, dataLine, expectedCode, privateDetail) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        ["event: response.failed", dataLine, ""].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));

    const error = await captureRejection(client.complete({ prompt: "hello" }));

    expect(error).toMatchObject({
      name: "CodexOAuthCompletionError",
      code: expectedCode
    });
    expect(String(error)).not.toContain(privateDetail);
    if (expectedCode === "stream_terminated") {
      expect(String(error)).not.toMatch(/abort/iu);
    }
  });

  it.each(["cancelled", "canceled"] as const)(
    "rejects a %s terminal response without exposing partial output or committing its id",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(
          [
            `event: response.${status}`,
            `data: {"type":"response.${status}","response":{"id":"discarded-response-id","status":"${status}","output":[{"type":"message","content":[{"type":"output_text","text":"sensitive-partial-output"}]}]}}`,
            ""
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        ))
      );
      const client = new CodexOAuthResponsesTextClient(async () => ({
        accessToken: "test-access-token",
        accountId: "acct_123"
      }));
      (client as unknown as { mostRecentResponseId?: string }).mostRecentResponseId = "existing-response-id";
      const progress: string[] = [];

      const error = await captureRejection(client.complete({
        prompt: "hello",
        onProgress: (event) => progress.push(event.text)
      }));

      expect(error).toMatchObject({
        code: "stream_terminated",
        retryDisposition: "caller_recovery"
      });
      expect(`${String(error)}\n${JSON.stringify(progress)}`).not.toContain("sensitive-partial-output");
      expect(`${String(error)}\n${JSON.stringify(progress)}`).not.toContain("discarded-response-id");
      expect(client.lastResponseId()).toBe("existing-response-id");
    }
  );

  it.each(["cancelled", "canceled"] as const)(
    "rejects response.completed when its response status is %s",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(
          [
            "event: response.completed",
            `data: {"type":"response.completed","response":{"id":"discarded-response-id","status":"${status}","output":[{"type":"message","content":[{"type":"output_text","text":"sensitive-partial-output"}]}]}}`,
            ""
          ].join("\n"),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        ))
      );
      const client = new CodexOAuthResponsesTextClient(async () => ({
        accessToken: "test-access-token",
        accountId: "acct_123"
      }));
      (client as unknown as { mostRecentResponseId?: string }).mostRecentResponseId = "existing-response-id";

      const error = await captureRejection(client.complete({ prompt: "hello" }));

      expect(error).toMatchObject({
        code: "stream_terminated",
        retryDisposition: "caller_recovery"
      });
      expect(String(error)).not.toContain("sensitive-partial-output");
      expect(String(error)).not.toContain("discarded-response-id");
      expect(client.lastResponseId()).toBe("existing-response-id");
    }
  );

  it("classifies top-level SSE error codes without exposing their message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: error",
          'data: {"type":"error","code":"rate_limit_exceeded","message":"sensitive-top-level-detail"}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));

    const error = await captureRejection(client.complete({ prompt: "hello" }));

    expect(error).toMatchObject({
      code: "rate_limited",
      retryDisposition: "backoff"
    });
    expect(String(error)).not.toContain("sensitive-top-level-detail");
  });

  it("does not emit content carried by a failed stream frame", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.failed.delta",
          'data: {"type":"response.failed.delta","delta":"sensitive-failure-delta","message":"sensitive-failure-message"}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));
    const progress: string[] = [];

    const error = await captureRejection(client.complete({
      prompt: "hello",
      onProgress: (event) => progress.push(event.text)
    }));

    expect(error).toMatchObject({ code: "provider_error" });
    const exposed = `${String(error)}\n${JSON.stringify(progress)}`;
    expect(exposed).not.toContain("sensitive-failure-delta");
    expect(exposed).not.toContain("sensitive-failure-message");
  });

  it("rejects a delta-only stream that ends without a success terminal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.created",
          'data: {"type":"response.created","response":{"id":"uncommitted-response-id","status":"in_progress"}}',
          "",
          "event: response.output_text.delta",
          'data: {"type":"response.output_text.delta","delta":"partial completion output"}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));
    (client as unknown as { mostRecentResponseId?: string }).mostRecentResponseId = "existing-response-id";
    const progress: Array<{ type: "status" | "delta"; text: string }> = [];

    await expect(client.complete({
      prompt: "hello",
      onProgress: (event) => progress.push(event)
    })).rejects.toMatchObject({
      name: "CodexOAuthCompletionError",
      code: "incomplete_response",
      retryDisposition: "caller_recovery"
    });

    expect(progress).toContainEqual({ type: "delta", text: "partial completion output" });
    expect(progress).not.toContainEqual({
      type: "status",
      text: "Received streamed Codex OAuth output."
    });
    expect(client.lastResponseId()).toBe("existing-response-id");
  });

  it("rejects a stream whose only done event completes non-output reasoning", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.created",
          'data: {"type":"response.created","response":{"id":"uncommitted-response-id","status":"in_progress"}}',
          "",
          "event: response.output_text.delta",
          'data: {"type":"response.output_text.delta","delta":"partial completion output"}',
          "",
          "event: response.reasoning_summary_text.done",
          'data: {"type":"response.reasoning_summary_text.done","text":"reasoning summary only"}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));
    (client as unknown as { mostRecentResponseId?: string }).mostRecentResponseId = "existing-response-id";

    await expect(client.complete({ prompt: "hello" })).rejects.toMatchObject({
      name: "CodexOAuthCompletionError",
      code: "incomplete_response",
      retryDisposition: "caller_recovery"
    });

    expect(client.lastResponseId()).toBe("existing-response-id");
  });

  it("ignores a non-output done candidate before a final response completion", async () => {
    const reasoningCanary = "non-output-reasoning-canary-that-is-longer-than-the-final-answer";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.created",
          'data: {"type":"response.created","response":{"id":"final-response-id","status":"in_progress"}}',
          "",
          "event: response.reasoning_summary_text.done",
          `data: {"type":"response.reasoning_summary_text.done","text":"${reasoningCanary}"}`,
          "",
          "event: response.completed",
          'data: {"type":"response.completed","response":{"id":"final-response-id","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"final"}]}]}}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));
    const progress: Array<{ type: "status" | "delta"; text: string }> = [];

    const result = await client.complete({
      prompt: "hello",
      onProgress: (event) => progress.push(event)
    });

    expect(result).toMatchObject({ text: "final", responseId: "final-response-id" });
    expect(JSON.stringify(result)).not.toContain(reasoningCanary);
    expect(JSON.stringify(progress)).not.toContain(reasoningCanary);
  });

  it("rejects a reasoning-only delta followed by an empty response completion", async () => {
    const reasoningCanary = "reasoning-only-completion-delta";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.created",
          'data: {"type":"response.created","response":{"id":"uncommitted-response-id","status":"in_progress"}}',
          "",
          "event: response.reasoning_summary_text.delta",
          `data: {"type":"response.reasoning_summary_text.delta","delta":"${reasoningCanary}"}`,
          "",
          "event: response.completed",
          'data: {"type":"response.completed","response":{"id":"uncommitted-response-id","status":"completed","output":[]}}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));
    (client as unknown as { mostRecentResponseId?: string }).mostRecentResponseId = "existing-response-id";
    const progress: Array<{ type: "status" | "delta"; text: string }> = [];

    await expect(
      client.complete({
        prompt: "hello",
        onProgress: (event) => progress.push(event)
      })
    ).rejects.toMatchObject({
      name: "CodexOAuthCompletionError",
      code: "empty_response",
      retryDisposition: "none"
    });
    expect(progress.filter((event) => event.type === "delta")).toEqual([]);
    expect(JSON.stringify(progress)).not.toContain(reasoningCanary);
    expect(progress).not.toContainEqual({
      type: "status",
      text: "Received streamed Codex OAuth output."
    });
    expect(progress).not.toContainEqual({ type: "status", text: "Received Codex OAuth output." });
    expect(client.lastResponseId()).toBe("existing-response-id");
  });

  it("rejects an unstructured message.completed frame without projecting its message", async () => {
    const nonOutputDetail = "non-output-message-detail";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.created",
          'data: {"type":"response.created","response":{"id":"uncommitted-response-id","status":"in_progress"}}',
          "",
          "event: message.completed",
          `data: {"type":"message.completed","item":{"type":"reasoning","summary":[]},"message":"${nonOutputDetail}"}`,
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));
    (client as unknown as { mostRecentResponseId?: string }).mostRecentResponseId = "existing-response-id";
    const progress: Array<{ type: "status" | "delta"; text: string }> = [];

    const error = await client.complete({
      prompt: "hello",
      onProgress: (event) => progress.push(event)
    }).catch((caught) => caught);

    expect(error).toMatchObject({
      name: "CodexOAuthCompletionError",
      code: "empty_response",
      retryDisposition: "none"
    });
    expect(`${String(error)}\n${JSON.stringify(progress)}`).not.toContain(nonOutputDetail);
    expect(progress.filter((event) => event.type === "delta")).toEqual([]);
    expect(client.lastResponseId()).toBe("existing-response-id");
  });

  it("returns only the final output after ignoring an earlier reasoning delta", async () => {
    const reasoningCanary = "long-reasoning-delta-that-must-not-outrank-the-short-final-output";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.created",
          'data: {"type":"response.created","response":{"id":"final-response-id","status":"in_progress"}}',
          "",
          "event: response.reasoning_summary_text.delta",
          `data: {"type":"response.reasoning_summary_text.delta","delta":"${reasoningCanary}"}`,
          "",
          "event: response.completed",
          'data: {"type":"response.completed","response":{"id":"final-response-id","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"final"}]}]}}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));
    const progress: Array<{ type: "status" | "delta"; text: string }> = [];

    const result = await client.complete({
      prompt: "hello",
      onProgress: (event) => progress.push(event)
    });

    expect(result).toMatchObject({ text: "final", responseId: "final-response-id" });
    expect(JSON.stringify(result)).not.toContain(reasoningCanary);
    expect(progress.filter((event) => event.type === "delta")).toEqual([]);
    expect(JSON.stringify(progress)).not.toContain(reasoningCanary);
  });

  it.each([
    ["reasoning item", '{"type":"reasoning","summary":[{"type":"summary_text","text":"reasoning only"}]}'],
    ["empty item", "{}"],
    [
      "message item without output_text content",
      '{"type":"message","content":[{"type":"reasoning_text","text":"non-output message text"}]}'
    ],
    [
      "message item with empty output_text content",
      '{"type":"message","content":[{"type":"output_text","text":""}]}'
    ]
  ])("rejects item.completed with a %s after an earlier output delta", async (_label, itemJson) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.created",
          'data: {"type":"response.created","response":{"id":"uncommitted-response-id","status":"in_progress"}}',
          "",
          "event: response.output_text.delta",
          'data: {"type":"response.output_text.delta","delta":"partial completion output"}',
          "",
          "event: item.completed",
          `data: {"type":"item.completed","item":${itemJson}}`,
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));
    (client as unknown as { mostRecentResponseId?: string }).mostRecentResponseId = "existing-response-id";

    await expect(client.complete({ prompt: "hello" })).rejects.toMatchObject({
      name: "CodexOAuthCompletionError",
      code: "incomplete_response",
      retryDisposition: "caller_recovery"
    });

    expect(client.lastResponseId()).toBe("existing-response-id");
  });

  it.each([
    ["reasoning item", '{"type":"reasoning","summary":[{"type":"summary_text","text":"reasoning only"}]}'],
    ["empty item", "{}"],
    ["non-message output_text item", '{"type":"output_text","text":"misplaced output text"}'],
    [
      "message item without output_text content",
      '{"type":"message","content":[{"type":"reasoning_text","text":"non-output message text"}]}'
    ],
    [
      "message item with empty output_text content",
      '{"type":"message","content":[{"type":"output_text","text":""}]}'
    ],
    [
      "incomplete message item",
      '{"type":"message","status":"incomplete","content":[{"type":"output_text","text":"uncommitted output"}]}'
    ],
    [
      "in-progress message item",
      '{"type":"message","status":"in_progress","content":[{"type":"output_text","text":"uncommitted output"}]}'
    ]
  ])("rejects response.output_item.done with a %s after an earlier output delta", async (_label, itemJson) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.created",
          'data: {"type":"response.created","response":{"id":"uncommitted-output-item-response-id","status":"in_progress"}}',
          "",
          "event: response.output_text.delta",
          'data: {"type":"response.output_text.delta","delta":"partial completion output"}',
          "",
          "event: response.output_item.done",
          `data: {"type":"response.output_item.done","output_index":0,"item":${itemJson},"sequence_number":1}`,
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));
    (client as unknown as { mostRecentResponseId?: string }).mostRecentResponseId = "existing-response-id";

    await expect(client.complete({ prompt: "hello" })).rejects.toMatchObject({
      name: "CodexOAuthCompletionError",
      code: "incomplete_response",
      retryDisposition: "caller_recovery"
    });

    expect(client.lastResponseId()).toBe("existing-response-id");
  });

  it("parses CRLF-delimited completion frames", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.output_text.delta\r\n",
          'data: {"type":"response.output_text.delta","delta":"crlf output"}\r\n',
          "\r\n",
          "event: response.completed\r\n",
          'data: {"type":"response.completed","response":{"id":"crlf-response","status":"completed"}}\r\n',
          "\r\n"
        ].join(""),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));

    await expect(client.complete({ prompt: "hello" })).resolves.toMatchObject({
      text: "crlf output",
      responseId: "crlf-response"
    });
  });

  it("sanitizes transport causes and stream-reader failures", async () => {
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));
    const transportError = new Error("sensitive-transport-detail", {
      cause: new Error("sensitive-transport-cause")
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw transportError;
    }));

    const transportFailure = await captureRejection(client.complete({ prompt: "hello" }));
    expect(transportFailure).toMatchObject({
      code: "transport_error",
      retryDisposition: "backoff"
    });
    const exposed = `${String(transportFailure)}\n${transportFailure instanceof Error ? transportFailure.stack : ""}\n${JSON.stringify(transportFailure)}`;
    expect(exposed).not.toContain("sensitive-transport-detail");
    expect(exposed).not.toContain("sensitive-transport-cause");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("sensitive-stream-reader-detail"));
        }
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } }))
    );
    const readerFailure = await captureRejection(client.complete({ prompt: "hello" }));
    expect(readerFailure).toMatchObject({ code: "transport_error" });
    expect(String(readerFailure)).not.toContain("sensitive-stream-reader-detail");
  });

  it("normalizes external abort details without turning them into provider failures", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("sensitive-abort-detail");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      }))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));
    const completion = client.complete({ prompt: "hello", abortSignal: controller.signal });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    controller.abort();

    const error = await captureRejection(completion);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(error).not.toBeInstanceOf(CodexOAuthCompletionError);
    expect(String(error)).not.toContain("sensitive-abort-detail");
  });

  it("posts a responses-style request to the ChatGPT Codex backend using the access token", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(_url).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer test-access-token",
        "ChatGPT-Account-ID": "acct_123",
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      });
      expect(JSON.parse(String(init?.body || "{}"))).toMatchObject({
        model: "gpt-5.3-codex",
        instructions: "system",
        store: false,
        stream: true,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: "hello" }]
          }
        ],
        text: { format: { type: "text" } },
        reasoning: { effort: "high" }
      });
      return new Response(
        [
          'event: response.created',
          'data: {"type":"response.created","response":{"id":"codex_resp_1","model":"gpt-5.3-codex","status":"in_progress","output":[]}}',
          "",
          'event: response.output_text.delta',
          'data: {"type":"response.output_text.delta","delta":"native codex reply"}',
          "",
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"codex_resp_1","model":"gpt-5.3-codex","status":"completed","usage":{"input_tokens":120,"output_tokens":30},"output":[{"type":"message","content":[{"type":"output_text","text":"native codex reply"}]}]}}',
          ""
        ].join("\n"),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CodexOAuthResponsesTextClient(
      async () => ({
        accessToken: "test-access-token",
        accountId: "acct_123"
      }),
      { model: "gpt-5.3-codex", reasoningEffort: "high" }
    );

    const result = await client.complete({
      prompt: "hello",
      systemPrompt: "system"
    });

    expect(result).toMatchObject({
      text: "native codex reply",
      responseId: "codex_resp_1",
      model: "gpt-5.3-codex",
      usage: {
        inputTokens: 120,
        outputTokens: 30
      }
    });
  });

  it("forwards streamed text deltas through the generic LLM progress callback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          [
            'event: response.created',
            'data: {"type":"response.created","response":{"id":"codex_resp_delta","model":"gpt-5.3-codex","status":"in_progress","output":[]}}',
            "",
            'event: response.output_text.delta',
            'data: {"type":"response.output_text.delta","delta":"first "}',
            "",
            'event: response.output_text.delta',
            'data: {"type":"response.output_text.delta","delta":"second"}',
            "",
            'event: response.completed',
            'data: {"type":"response.completed","response":{"id":"codex_resp_delta","model":"gpt-5.3-codex","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"first second"}]}]}}',
            ""
          ].join("\n"),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" }
          }
        );
      })
    );

    const textClient = new CodexOAuthResponsesTextClient(
      async () => ({
        accessToken: "test-access-token",
        accountId: "acct_123"
      }),
      { model: "gpt-5.3-codex", reasoningEffort: "high" }
    );
    const llmClient = new CodexOAuthResponsesLLMClient(textClient);
    const progress: Array<{ type: "status" | "delta"; text: string }> = [];

    const result = await llmClient.complete("hello", {
      onProgress: (event) => progress.push(event)
    });

    expect(result.text).toBe("first second");
    expect(progress).toContainEqual({ type: "delta", text: "first " });
    expect(progress).toContainEqual({ type: "delta", text: "second" });
    expect(progress).toContainEqual({ type: "status", text: "Received Codex OAuth output." });
  });

  it("prefers authoritative response output over a longer streamed partial", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.created",
          'data: {"type":"response.created","response":{"id":"authoritative-response-id","status":"in_progress","output":[]}}',
          "",
          "event: response.output_text.delta",
          'data: {"type":"response.output_text.delta","delta":"STALE_LONG_PARTIAL"}',
          "",
          "event: response.completed",
          'data: {"type":"response.completed","response":{"id":"authoritative-response-id","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"OK"}]}]}}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));

    const result = await client.complete({ prompt: "hello" });

    expect(result).toMatchObject({ text: "OK", responseId: "authoritative-response-id" });
  });

  it("falls back to assembled JSON output deltas when the completed payload omits output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.created",
          'data: {"type":"response.created","response":{"id":"json-delta-response-id","status":"in_progress","output":[]}}',
          "",
          "event: response.output_text.delta",
          'data: {"type":"response.output_text.delta","delta":"{\\"status\\":"}',
          "",
          "event: response.output_text.delta",
          'data: {"type":"response.output_text.delta","delta":"\\"OK\\"}"}',
          "",
          "event: response.completed",
          'data: {"type":"response.completed","response":{"id":"json-delta-response-id","status":"completed","output":[]}}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));

    const result = await client.complete({ prompt: "hello" });

    expect(result).toMatchObject({
      text: '{"status":"OK"}',
      responseId: "json-delta-response-id"
    });
  });

  it("does not commit a response id when the final progress observer fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.completed",
          'data: {"type":"response.completed","response":{"id":"new-response-id","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"usable output"}]}]}}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));
    (client as unknown as { mostRecentResponseId?: string }).mostRecentResponseId = "existing-response-id";

    const error = await captureRejection(client.complete({
      prompt: "hello",
      onProgress: (event) => {
        if (event.text === "Received Codex OAuth output.") {
          throw new Error("observer-failure-sentinel");
        }
      }
    }));

    expect(error).toMatchObject({
      code: "observer_error",
      retryDisposition: "none"
    });
    expect(String(error)).not.toContain("observer-failure-sentinel");
    expect(client.lastResponseId()).toBe("existing-response-id");
  });

  it("does not reclassify a streaming progress observer failure as a retryable transport error", async () => {
    const cancel = vi.fn();
    const fetchMock = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode([
          "event: response.output_text.delta",
          'data: {"type":"response.output_text.delta","delta":"usable delta"}',
          "",
          ""
        ].join("\n")));
      },
      cancel
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));
    (client as unknown as { mostRecentResponseId?: string }).mostRecentResponseId = "existing-response-id";

    const error = await captureRejection(client.complete({
      prompt: "hello",
      onProgress: (event) => {
        if (event.type === "delta") {
          throw new Error("observer-failure-sentinel");
        }
      }
    }));

    expect(error).toMatchObject({
      code: "observer_error",
      retryDisposition: "none",
      retryable: false
    });
    expect(String(error)).not.toContain("observer-failure-sentinel");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(client.lastResponseId()).toBe("existing-response-id");
  });

  it("sanitizes the first outer LLM progress observer failure before any provider request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const textClient = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "fixture-account"
    }));
    const llmClient = new CodexOAuthResponsesLLMClient(textClient);

    const error = await captureRejection(llmClient.complete("hello", {
      onProgress: () => {
        throw new Error("outer-observer-failure-sentinel");
      }
    }));

    expect(error).toMatchObject({
      code: "observer_error",
      retryDisposition: "none"
    });
    expect(String(error)).not.toContain("outer-observer-failure-sentinel");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts an in-progress SSE stream read when the abort signal fires", async () => {
    const encoder = new TextEncoder();
    const stream = new TransformStream<Uint8Array>();
    const writer = stream.writable.getWriter();
    const fetchMock = vi.fn(async () => {
      return new Response(stream.readable, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CodexOAuthResponsesTextClient(
      async () => ({
        accessToken: "test-access-token",
        accountId: "acct_123"
      }),
      { model: "gpt-5.3-codex", reasoningEffort: "high" }
    );
    const controller = new AbortController();
    const completion = client.complete({
      prompt: "hello",
      abortSignal: controller.signal
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await writer.write(
      encoder.encode(
        [
          "event: response.output_text.delta",
          'data: {"type":"response.output_text.delta","delta":"partial"}',
          "",
          ""
        ].join("\n")
      )
    );
    controller.abort();

    await expect(completion).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not send previous_response_id when only a threadId is provided", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      expect(body).not.toHaveProperty("previous_response_id");
      return new Response(
        [
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"codex_resp_2","model":"gpt-5.3-codex","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}}',
          ""
        ].join("\n"),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CodexOAuthResponsesTextClient(
      async () => ({
        accessToken: "test-access-token",
        accountId: "acct_123"
      }),
      { model: "gpt-5.3-codex", reasoningEffort: "high" }
    );

    const result = await client.complete({
      prompt: "hello",
      threadId: "thread-opaque-id"
    });

    expect(result.text).toBe("ok");
  });

  it("sends previous_response_id only when explicitly provided", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      expect(body.previous_response_id).toBe("resp_explicit");
      return new Response(
        [
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"codex_resp_3","model":"gpt-5.3-codex","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}}',
          ""
        ].join("\n"),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CodexOAuthResponsesTextClient(
      async () => ({
        accessToken: "test-access-token",
        accountId: "acct_123"
      }),
      { model: "gpt-5.3-codex", reasoningEffort: "high" }
    );

    const result = await client.complete({
      prompt: "hello",
      threadId: "thread-opaque-id",
      previousResponseId: "resp_explicit"
    });

    expect(result.text).toBe("ok");
  });

  it("salvages text from item.completed when the stream never emits response.completed", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        [
          'event: response.created',
          'data: {"type":"response.created","response":{"id":"codex_resp_4","model":"gpt-5.3-codex","status":"in_progress","output":[]}}',
          "",
          'event: item.completed',
          'data: {"type":"item.completed","item":{"type":"message","content":[{"type":"output_text","text":"partial-but-usable"}]}}',
          ""
        ].join("\n"),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CodexOAuthResponsesTextClient(
      async () => ({
        accessToken: "test-access-token",
        accountId: "acct_123"
      }),
      { model: "gpt-5.3-codex", reasoningEffort: "high" }
    );

    const result = await client.complete({ prompt: "hello" });

    expect(result).toMatchObject({
      text: "partial-but-usable",
      responseId: "codex_resp_4",
      model: "gpt-5.3-codex"
    });
  });

  it("accepts a standard response.output_item.done terminal and retains the created response id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.created",
          'data: {"type":"response.created","response":{"id":"output-item-response-id","model":"configured-chat-model","status":"in_progress","output":[]}}',
          "",
          "event: response.output_item.done",
          'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"message-item-id","status":"completed","type":"message","role":"assistant","content":[{"type":"output_text","text":"final output item text","annotations":[]}]},"sequence_number":1}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));

    const result = await client.complete({ prompt: "hello", model: "configured-chat-model" });

    expect(result).toMatchObject({
      text: "final output item text",
      responseId: "output-item-response-id",
      model: "configured-chat-model"
    });
    expect(result.responseId).not.toBe("message-item-id");
    expect(client.lastResponseId()).toBe("output-item-response-id");
  });

  it("salvages output_text.done text when the response payload never leaves in_progress", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        [
          'event: response.created',
          'data: {"type":"response.created","response":{"id":"codex_resp_5","model":"gpt-5.3-codex","status":"in_progress","output":[]}}',
          "",
          'event: response.output_text.done',
          'data: {"type":"response.output_text.done","text":"final text from done event"}',
          ""
        ].join("\n"),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CodexOAuthResponsesTextClient(
      async () => ({
        accessToken: "test-access-token",
        accountId: "acct_123"
      }),
      { model: "gpt-5.3-codex", reasoningEffort: "high" }
    );

    const result = await client.complete({ prompt: "hello" });

    expect(result.text).toBe("final text from done event");
    expect(result.responseId).toBe("codex_resp_5");
  });

  it("prefers a structured terminal message over a stale pre-terminal response snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.created",
          'data: {"type":"response.created","response":{"id":"terminal-message-response-id","status":"in_progress","output":[{"type":"message","content":[{"type":"output_text","text":"stale response snapshot"}]}]}}',
          "",
          "event: message.completed",
          'data: {"type":"message.completed","content":[{"type":"output_text","text":"final message output"}]}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));

    await expect(client.complete({ prompt: "hello" })).resolves.toMatchObject({
      text: "final message output",
      responseId: "terminal-message-response-id"
    });
  });

  it("rejects an empty final response instead of reviving a pre-terminal output snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.created",
          'data: {"type":"response.created","response":{"id":"uncommitted-response-id","status":"in_progress","output":[{"type":"message","content":[{"type":"output_text","text":"stale response snapshot"}]}]}}',
          "",
          "event: response.completed",
          'data: {"type":"response.completed","response":{"id":"uncommitted-response-id","status":"completed","output":[]}}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));
    (client as unknown as { mostRecentResponseId?: string }).mostRecentResponseId = "existing-response-id";
    const progress: Array<{ type: "status" | "delta"; text: string }> = [];

    await expect(client.complete({
      prompt: "hello",
      onProgress: (event) => progress.push(event)
    })).rejects.toMatchObject({ code: "empty_response" });

    expect(progress).not.toContainEqual({ type: "status", text: "Received Codex OAuth output." });
    expect(client.lastResponseId()).toBe("existing-response-id");
  });

  it("uses the latest structured terminal candidate when no response completion exists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: item.completed",
          'data: {"type":"item.completed","item":{"type":"message","content":[{"type":"output_text","text":"older terminal candidate with more characters"}]}}',
          "",
          "event: message.completed",
          'data: {"type":"message.completed","content":[{"type":"output_text","text":"latest"}]}',
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));

    await expect(client.complete({ prompt: "hello" })).resolves.toMatchObject({ text: "latest" });
  });

  it.each([
    [
      "item.completed",
      'event: item.completed\ndata: {"type":"item.completed","item":{"type":"message","content":[{"type":"output_text","text":"OK"}]}}\n'
    ],
    [
      "response.output_text.done",
      'event: response.output_text.done\ndata: {"type":"response.output_text.done","text":"OK"}\n'
    ],
    [
      "message.completed",
      'event: message.completed\ndata: {"type":"message.completed","content":[{"type":"output_text","text":"OK"}]}\n'
    ]
  ])("prefers an exact %s terminal candidate over a longer streamed partial", async (_type, terminalFrame) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        [
          "event: response.created",
          'data: {"type":"response.created","response":{"id":"terminal-candidate-response-id","status":"in_progress","output":[]}}',
          "",
          "event: response.output_text.delta",
          'data: {"type":"response.output_text.delta","delta":"STALE_LONG_PARTIAL"}',
          "",
          terminalFrame,
          ""
        ].join("\n"),
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      ))
    );
    const client = new CodexOAuthResponsesTextClient(async () => ({
      accessToken: "test-access-token",
      accountId: "acct_123"
    }));

    const result = await client.complete({ prompt: "hello" });

    expect(result).toMatchObject({
      text: "OK",
      responseId: "terminal-candidate-response-id"
    });
  });
});
