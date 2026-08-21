import path from "node:path";
import { promises as fs } from "node:fs";
import { isAbortLikeError } from "../openai/networkError.js";
import { computeModelUsageCostUsd } from "../../core/llm/modelPricing.js";
import { OpenAiResponsesUsage, extractOpenAiResponsesUsage } from "../openai/usage.js";
import { CodexOAuthCredentials } from "./oauthAuth.js";
import { RECOMMENDED_CODEX_MODEL } from "./modelCatalog.js";
import {
  CodexOAuthCompletionError,
  CodexOAuthCompletionErrorCode,
  isCodexOAuthCompletionError,
  makeCodexOAuthAbortError
} from "./oauthCompletionError.js";

export interface CodexOAuthResponsesTextResult {
  text: string;
  responseId?: string;
  model?: string;
  usage?: OpenAiResponsesUsage;
}

export interface CodexOAuthResponsesTextDefaults {
  model?: string;
  reasoningEffort?: string;
}

export interface CodexOAuthResponsesProgressEvent {
  type: "status" | "delta";
  text: string;
}

export type CodexOAuthCompatibilityProbeStatus =
  | "compatible"
  | "fixture_active"
  | "auth_unavailable"
  | "request_rejected"
  | "rate_limited"
  | "timeout"
  | "transport_error"
  | "empty_response"
  | "provider_error";

export interface CodexOAuthCompatibilityProbeResult {
  status: CodexOAuthCompatibilityProbeStatus;
}

export interface CodexOAuthCompatibilityProbeOptions {
  model: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

interface CodexResponsesApiResponse {
  id?: string;
  model?: string;
  status?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: {
      cached_tokens?: number;
    } | null;
    output_tokens_details?: {
      reasoning_tokens?: number;
    } | null;
  } | null;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  } | null;
  incomplete_details?: {
    reason?: string;
  } | null;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
}

interface CodexResponsesEvent {
  type?: string;
  code?: string;
  delta?: string;
  text?: string;
  response?: CodexResponsesApiResponse;
  item?: Record<string, unknown>;
  content?: unknown;
  output_text?: string;
  message?: string;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  } | null;
}

export class CodexOAuthResponsesTextClient {
  private defaults: Required<CodexOAuthResponsesTextDefaults>;
  private mostRecentResponseId?: string;

  constructor(
    private readonly resolveCredentials: () => Promise<CodexOAuthCredentials | undefined>,
    defaults: CodexOAuthResponsesTextDefaults = {}
  ) {
    this.defaults = {
      model: defaults.model || RECOMMENDED_CODEX_MODEL,
      reasoningEffort: defaults.reasoningEffort || "high"
    };
  }

  updateDefaults(next: CodexOAuthResponsesTextDefaults): void {
    this.defaults = {
      model: next.model || this.defaults.model,
      reasoningEffort: next.reasoningEffort || this.defaults.reasoningEffort
    };
  }

  lastResponseId(): string | undefined {
    return this.mostRecentResponseId;
  }

  async runForText(opts: {
    prompt: string;
    threadId?: string;
    previousResponseId?: string;
    systemPrompt?: string;
    inputImagePaths?: string[];
    model?: string;
    reasoningEffort?: string;
    abortSignal?: AbortSignal;
    onProgress?: (event: CodexOAuthResponsesProgressEvent) => void;
  }): Promise<string> {
    const result = await this.complete(opts);
    return result.text;
  }

  async complete(opts: {
    prompt: string;
    threadId?: string;
    previousResponseId?: string;
    systemPrompt?: string;
    inputImagePaths?: string[];
    model?: string;
    reasoningEffort?: string;
    abortSignal?: AbortSignal;
    onProgress?: (event: CodexOAuthResponsesProgressEvent) => void;
  }): Promise<CodexOAuthResponsesTextResult> {
    if (opts.abortSignal?.aborted) {
      throw makeAbortError();
    }
    let credentials: CodexOAuthCredentials | undefined;
    try {
      credentials = await this.resolveCredentials();
    } catch {
      if (opts.abortSignal?.aborted) {
        throw makeAbortError();
      }
      throw new CodexOAuthCompletionError("auth_unavailable");
    }
    if (!credentials?.accessToken) {
      throw new CodexOAuthCompletionError("auth_unavailable");
    }

    const content: Array<Record<string, unknown>> = [{ type: "input_text", text: opts.prompt }];
    let imageParts: Array<Record<string, unknown>>;
    try {
      imageParts = await Promise.all(
        (opts.inputImagePaths || []).map((imagePath) => buildImageContentPart(imagePath))
      );
    } catch {
      if (opts.abortSignal?.aborted) {
        throw makeAbortError();
      }
      throw new CodexOAuthCompletionError("input_unavailable");
    }
    content.push(...imageParts);

    if (opts.abortSignal?.aborted) {
      throw makeAbortError();
    }

    const body: Record<string, unknown> = {
      model: opts.model || this.defaults.model,
      instructions: opts.systemPrompt || "You are Codex. Follow the user's request carefully.",
      store: false,
      stream: true,
      input: [
        {
          role: "user",
          content
        }
      ],
      text: {
        format: {
          type: "text"
        }
      },
      reasoning: {
        effort: opts.reasoningEffort || this.defaults.reasoningEffort
      }
    };

    if (opts.previousResponseId) {
      body.previous_response_id = opts.previousResponseId;
    }

    emitCodexOAuthProgress(opts.onProgress, {
      type: "status",
      text: "Submitting request to Codex OAuth Responses backend."
    });

    const headers = buildCodexOAuthHeaders(credentials);

    let response: Response;
    try {
      response = await fetch("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST",
        headers,
        signal: opts.abortSignal,
        redirect: "error",
        body: JSON.stringify(body)
      });
    } catch (error) {
      if (opts.abortSignal?.aborted) {
        throw makeAbortError();
      }
      if (isCodexOAuthCompletionError(error)) {
        throw error;
      }
      throw new CodexOAuthCompletionError("transport_error");
    }

    if (!response.ok) {
      const failureCode = await classifyCodexOAuthHttpFailure(response, opts.abortSignal);
      if (opts.abortSignal?.aborted) {
        throw makeAbortError();
      }
      throw new CodexOAuthCompletionError(failureCode);
    }

    let streamed: Awaited<ReturnType<typeof readCodexStream>>;
    try {
      streamed = await readCodexStream(response, opts.onProgress, opts.abortSignal);
    } catch (error) {
      if (opts.abortSignal?.aborted) {
        throw makeAbortError();
      }
      if (isCodexOAuthCompletionError(error)) {
        throw error;
      }
      throw new CodexOAuthCompletionError("transport_error");
    }
    if (streamed.failureCode) {
      throw new CodexOAuthCompletionError(streamed.failureCode);
    }

    const payload = streamed.payload;
    const text = streamed.text;
    if (!text) {
      throw new CodexOAuthCompletionError("empty_response");
    }
    if (!streamed.terminalSuccess) {
      throw new CodexOAuthCompletionError("incomplete_response");
    }

    const usage = extractOpenAiResponsesUsage(payload);
    if (usage) {
      usage.costUsd = computeModelUsageCostUsd(payload.model || String(body.model || this.defaults.model), usage);
    }

    emitCodexOAuthProgress(opts.onProgress, {
      type: "status",
      text: "Received Codex OAuth output."
    });
    this.mostRecentResponseId = payload.id;

    return {
      text,
      responseId: payload.id,
      model: payload.model || String(body.model || this.defaults.model),
      usage
    };
  }

  async probeCompatibility(
    opts: CodexOAuthCompatibilityProbeOptions
  ): Promise<CodexOAuthCompatibilityProbeResult> {
    const credentials = await this.resolveCredentials();
    if (!credentials?.accessToken || !credentials.accountId) {
      return { status: "auth_unavailable" };
    }
    if (opts.abortSignal?.aborted) {
      throw makeAbortError();
    }

    const timeoutMs = normalizeCompatibilityProbeTimeout(opts.timeoutMs);
    const controller = new AbortController();
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let rejectExternalAbort: ((error: Error) => void) | undefined;
    const onExternalAbort = () => {
      controller.abort();
      rejectExternalAbort?.(makeAbortError());
    };
    opts.abortSignal?.addEventListener("abort", onExternalAbort, { once: true });

    const request = runCodexCompatibilityProbeRequest({
      credentials,
      model: opts.model,
      signal: controller.signal
    });
    const timeout = new Promise<CodexOAuthCompatibilityProbeResult>((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        resolve({ status: "timeout" });
      }, timeoutMs);
    });
    const externalAbort = new Promise<never>((_resolve, reject) => {
      rejectExternalAbort = reject;
    });

    try {
      return await Promise.race([request, timeout, externalAbort]);
    } catch (error) {
      if (opts.abortSignal?.aborted) {
        throw makeAbortError();
      }
      if (timedOut || (controller.signal.aborted && isAbortLikeError(error))) {
        return { status: "timeout" };
      }
      return { status: "transport_error" };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      opts.abortSignal?.removeEventListener("abort", onExternalAbort);
    }
  }
}

const DEFAULT_COMPATIBILITY_PROBE_TIMEOUT_MS = 12_000;
const MAX_COMPATIBILITY_PROBE_TIMEOUT_MS = 60_000;
const MAX_COMPATIBILITY_PROBE_RESPONSE_BYTES = 256 * 1024;
const MAX_COMPLETION_ERROR_METADATA_BYTES = 32 * 1024;
const MAX_COMPLETION_ERROR_METADATA_READ_MS = 1_000;

function buildCodexOAuthHeaders(credentials: CodexOAuthCredentials): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream"
  };
  if (credentials.accountId) {
    headers["ChatGPT-Account-ID"] = credentials.accountId;
  }
  return headers;
}

function normalizeCompatibilityProbeTimeout(timeoutMs: number | undefined): number {
  if (!Number.isFinite(timeoutMs)) {
    return DEFAULT_COMPATIBILITY_PROBE_TIMEOUT_MS;
  }
  return Math.min(MAX_COMPATIBILITY_PROBE_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs as number)));
}

async function runCodexCompatibilityProbeRequest(input: {
  credentials: CodexOAuthCredentials;
  model: string;
  signal: AbortSignal;
}): Promise<CodexOAuthCompatibilityProbeResult> {
  let response: Response;
  try {
    response = await fetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      redirect: "error",
      headers: buildCodexOAuthHeaders(input.credentials),
      signal: input.signal,
      body: JSON.stringify({
        model: input.model,
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
      })
    });
  } catch (error) {
    if (isAbortLikeError(error) || input.signal.aborted) {
      throw makeAbortError();
    }
    return { status: "transport_error" };
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) {
      return { status: "auth_unavailable" };
    }
    if ([400, 404, 409, 422].includes(response.status)) {
      return { status: "request_rejected" };
    }
    if (response.status === 429) {
      return { status: "rate_limited" };
    }
    return { status: "provider_error" };
  }

  try {
    return await consumeCodexCompatibilityProbeResponse(response, input.signal);
  } catch (error) {
    if (isAbortLikeError(error) || input.signal.aborted) {
      throw makeAbortError();
    }
    return { status: "transport_error" };
  }
}

async function consumeCodexCompatibilityProbeResponse(
  response: Response,
  abortSignal: AbortSignal
): Promise<CodexOAuthCompatibilityProbeResult> {
  const reader = response.body?.getReader();
  if (!reader) {
    return { status: "empty_response" };
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let totalBytes = 0;
  let hasUsableText = false;
  let terminalSuccess = false;

  try {
    while (true) {
      const { done, value } = await readCodexStreamChunk(reader, abortSignal);
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_COMPATIBILITY_PROBE_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { status: "provider_error" };
      }

      buffer += decoder.decode(value, { stream: true });
      let boundary = findSseBoundary(buffer);
      while (boundary) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const inspected = inspectCodexCompatibilityFrame(frame);
        if (inspected.failed) {
          await reader.cancel().catch(() => undefined);
          return { status: "provider_error" };
        }
        hasUsableText ||= inspected.hasUsableText;
        terminalSuccess ||= inspected.terminalSuccess;
        boundary = findSseBoundary(buffer);
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      const inspected = inspectCodexCompatibilityFrame(buffer);
      if (inspected.failed) {
        return { status: "provider_error" };
      }
      hasUsableText ||= inspected.hasUsableText;
      terminalSuccess ||= inspected.terminalSuccess;
    }
    if (!terminalSuccess) {
      return hasUsableText ? { status: "provider_error" } : { status: "empty_response" };
    }
    return hasUsableText ? { status: "compatible" } : { status: "empty_response" };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Abort cancellation can still own the pending read; release is best effort.
    }
  }
}

function findSseBoundary(buffer: string): { index: number; length: number } | undefined {
  const lfIndex = buffer.indexOf("\n\n");
  const crlfIndex = buffer.indexOf("\r\n\r\n");
  if (lfIndex < 0 && crlfIndex < 0) {
    return undefined;
  }
  if (crlfIndex >= 0 && (lfIndex < 0 || crlfIndex < lfIndex)) {
    return { index: crlfIndex, length: 4 };
  }
  return { index: lfIndex, length: 2 };
}

function inspectCodexCompatibilityFrame(frame: string): {
  failed: boolean;
  hasUsableText: boolean;
  terminalSuccess: boolean;
} {
  const event = parseSseFrame(frame);
  if (!event) {
    return { failed: false, hasUsableText: false, terminalSuccess: false };
  }

  const type = typeof event.type === "string" ? event.type.toLowerCase() : "";
  const status = event.response?.status?.toLowerCase() || "";
  const failed = Boolean(
    classifyCodexOAuthStreamFailure(event)
    || event.response?.error
    || event.response?.incomplete_details
    || (event as unknown as Record<string, unknown>).error
    || type === "error"
    || type.endsWith(".error")
    || type.endsWith(".failed")
    || type.endsWith(".incomplete")
    || status === "failed"
    || status === "incomplete"
  );
  return {
    failed,
    terminalSuccess: !failed && isCodexOAuthSuccessTerminal(event),
    hasUsableText: Boolean(
      extractDeltaText(event).trim()
      || extractCompletedTextCandidate(event)?.trim()
    )
  };
}

async function buildImageContentPart(imagePath: string): Promise<Record<string, unknown>> {
  const bytes = await fs.readFile(imagePath);
  return {
    type: "input_image",
    image_url: `data:${inferImageMimeType(imagePath)};base64,${bytes.toString("base64")}`
  };
}

function inferImageMimeType(imagePath: string): string {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") {
    return "image/jpeg";
  }
  if (ext === ".webp") {
    return "image/webp";
  }
  if (ext === ".gif") {
    return "image/gif";
  }
  return "image/png";
}

async function readCodexStream(
  response: Response,
  onProgress?: (event: CodexOAuthResponsesProgressEvent) => void,
  abortSignal?: AbortSignal
): Promise<{
  text: string;
  payload: CodexResponsesApiResponse;
  failureCode?: CodexOAuthCompletionErrorCode;
  terminalSuccess: boolean;
}> {
  const reader = response.body?.getReader();
  if (!reader) {
    return {
      text: "",
      payload: {},
      terminalSuccess: false
    };
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let payload: CodexResponsesApiResponse = {};
  let failureCode: CodexOAuthCompletionErrorCode | undefined;
  let terminalSuccess = false;
  let authoritativeFinalText = "";
  const candidateTexts: string[] = [];

  try {
    streamRead:
    while (true) {
      const { done, value } = await readCodexStreamChunk(reader, abortSignal);
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = findSseBoundary(buffer);
      while (boundary) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const event = parseSseFrame(frame);
        if (event) {
          const eventFailureCode = classifyCodexOAuthStreamFailure(event);
          failureCode ||= eventFailureCode;
          if (!failureCode) {
            terminalSuccess ||= isCodexOAuthSuccessTerminal(event);
            if (normalizeCodexResponsesEventType(event) === "response.completed") {
              authoritativeFinalText = extractOutputText(event.response || {});
            }
            const delta = extractDeltaText(event);
            if (delta) {
              text += delta;
              emitCodexOAuthProgress(onProgress, { type: "delta", text: delta });
            }
            rememberCandidateText(candidateTexts, extractCompletedTextCandidate(event));
          }
          if (event.response) {
            payload = mergePayload(payload, event.response);
          }
          if (failureCode) {
            void reader.cancel().catch(() => undefined);
            buffer = "";
            break streamRead;
          }
        }
        boundary = findSseBoundary(buffer);
      }
    }

    const trailing = failureCode ? "" : buffer.trim();
    if (trailing) {
      const event = parseSseFrame(trailing);
      if (event) {
        const eventFailureCode = classifyCodexOAuthStreamFailure(event);
        failureCode ||= eventFailureCode;
        if (!failureCode) {
          terminalSuccess ||= isCodexOAuthSuccessTerminal(event);
          if (normalizeCodexResponsesEventType(event) === "response.completed") {
            authoritativeFinalText = extractOutputText(event.response || {});
          }
          const delta = extractDeltaText(event);
          if (delta) {
            text += delta;
            emitCodexOAuthProgress(onProgress, { type: "delta", text: delta });
          }
          rememberCandidateText(candidateTexts, extractCompletedTextCandidate(event));
        }
        if (event.response) {
          payload = mergePayload(payload, event.response);
        }
      }
    }
  } catch (error) {
    if (isCodexOAuthCompletionError(error) && error.code === "observer_error") {
      void reader.cancel().catch(() => undefined);
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // An aborted read may still own the lock; releasing is best effort.
    }
  }

  return {
    text: selectBestText(text, authoritativeFinalText, candidateTexts),
    payload,
    failureCode,
    terminalSuccess
  };
}

async function classifyCodexOAuthHttpFailure(
  response: Response,
  abortSignal?: AbortSignal
): Promise<CodexOAuthCompletionErrorCode> {
  if (response.status === 401 || response.status === 403) {
    cancelResponseBody(response);
    return "auth_unavailable";
  }
  if ([400, 404, 409, 422].includes(response.status)) {
    cancelResponseBody(response);
    return "request_rejected";
  }
  if (response.status === 429) {
    const metadata = await readBoundedCompletionErrorMetadata(response, abortSignal);
    return isQuotaExhaustionMetadata(metadata) ? "quota_exhausted" : "rate_limited";
  }
  cancelResponseBody(response);
  if (response.status >= 500 && response.status <= 599) {
    return "provider_unavailable";
  }
  return "provider_error";
}

function cancelResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function readBoundedCompletionErrorMetadata(
  response: Response,
  abortSignal?: AbortSignal
): Promise<{ type?: string; code?: string } | undefined> {
  const reader = response.body?.getReader();
  if (!reader) {
    return undefined;
  }
  const decoder = new TextDecoder();
  let raw = "";
  let totalBytes = 0;
  const deadline = Date.now() + MAX_COMPLETION_ERROR_METADATA_READ_MS;
  try {
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      const { done, value } = await readCodexStreamChunkWithDeadline(
        reader,
        abortSignal,
        remainingMs
      );
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_COMPLETION_ERROR_METADATA_BYTES) {
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const error = (parsed as Record<string, unknown>).error;
    if (!error || typeof error !== "object") {
      return undefined;
    }
    const record = error as Record<string, unknown>;
    return {
      type: typeof record.type === "string" ? record.type : undefined,
      code: typeof record.code === "string" ? record.code : undefined
    };
  } catch (error) {
    if (abortSignal?.aborted) {
      void reader.cancel().catch(() => undefined);
      throw makeAbortError();
    }
    if (error instanceof CompletionErrorMetadataTimeout) {
      void reader.cancel().catch(() => undefined);
    }
    return undefined;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Cancellation can retain the lock; releasing is best effort.
    }
  }
}

class CompletionErrorMetadataTimeout extends Error {}

async function readCodexStreamChunkWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  abortSignal: AbortSignal | undefined,
  timeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readCodexStreamChunk(reader, abortSignal),
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new CompletionErrorMetadataTimeout()), timeoutMs);
      })
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function isQuotaExhaustionMetadata(metadata: { type?: string; code?: string } | undefined): boolean {
  return [metadata?.type, metadata?.code]
    .filter((value): value is string => typeof value === "string")
    .some((value) => ["usage_limit_reached", "quota_exhausted"].includes(value.trim().toLowerCase()));
}

async function readCodexStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  abortSignal?: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!abortSignal) {
    return reader.read();
  }
  if (abortSignal.aborted) {
    throw makeAbortError();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => abortSignal.removeEventListener("abort", onAbort);
    const settle = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = () => {
      void reader.cancel().catch(() => undefined);
      settle(() => reject(makeAbortError()));
    };

    abortSignal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error))
    );
  });
}

function makeAbortError(): Error {
  return makeCodexOAuthAbortError();
}

function emitCodexOAuthProgress(
  onProgress: ((event: CodexOAuthResponsesProgressEvent) => void) | undefined,
  event: CodexOAuthResponsesProgressEvent
): void {
  try {
    onProgress?.(event);
  } catch {
    throw new CodexOAuthCompletionError("observer_error");
  }
}

function parseSseFrame(frame: string): CodexResponsesEvent | undefined {
  const dataLines = frame
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  if (dataLines.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(dataLines.join("\n")) as CodexResponsesEvent;
  } catch {
    return undefined;
  }
}

function classifyCodexOAuthStreamFailure(
  event: CodexResponsesEvent
): CodexOAuthCompletionErrorCode | undefined {
  const type = event.type?.trim().toLowerCase() || "";
  const responseStatus = event.response?.status?.trim().toLowerCase() || "";
  const isCancelledEnvelope =
    type === "cancelled"
    || type === "canceled"
    || type.endsWith(".cancelled")
    || type.endsWith(".canceled")
    || type.includes(".cancelled.")
    || type.includes(".canceled.")
    || responseStatus === "cancelled"
    || responseStatus === "canceled";
  const isFailureEnvelope =
    type === "error"
    || type.endsWith(".error")
    || type.includes(".error.")
    || type.endsWith(".failed")
    || type.includes(".failed.")
    || type.endsWith(".incomplete")
    || type.includes(".incomplete.")
    || isCancelledEnvelope
    || responseStatus === "failed"
    || responseStatus === "incomplete";
  const providerError = event.error || event.response?.error;
  const metadataCode = classifyCodexOAuthProviderMetadata(providerError);
  if (metadataCode) {
    return metadataCode;
  }
  if (isCancelledEnvelope) {
    return "stream_terminated";
  }
  if (isFailureEnvelope && (event.code || event.message)) {
    const topLevelMetadataCode = classifyCodexOAuthProviderMetadata({
      code: event.code,
      message: event.message
    });
    if (topLevelMetadataCode) {
      return topLevelMetadataCode;
    }
  }

  const incompleteReason = event.response?.incomplete_details?.reason;
  if (incompleteReason && looksLikeProviderStreamTermination(incompleteReason)) {
    return "stream_terminated";
  }
  if (
    event.response?.incomplete_details
    || type.endsWith(".incomplete")
    || type.includes(".incomplete.")
    || responseStatus === "incomplete"
  ) {
    return "incomplete_response";
  }
  if (
    type === "error"
    || type.endsWith(".error")
    || type.includes(".error.")
    || type.endsWith(".failed")
    || type.includes(".failed.")
    || responseStatus === "failed"
  ) {
    if (event.message && looksLikeProviderStreamTermination(event.message)) {
      return "stream_terminated";
    }
    return "provider_error";
  }
  return undefined;
}

function classifyCodexOAuthProviderMetadata(
  metadata: { message?: string; type?: string; code?: string } | null | undefined
): CodexOAuthCompletionErrorCode | undefined {
  if (!metadata) {
    return undefined;
  }
  const identifiers = [metadata.type, metadata.code]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase());
  if (identifiers.some((value) => ["usage_limit_reached", "quota_exhausted"].includes(value))) {
    return "quota_exhausted";
  }
  if (identifiers.some((value) => ["rate_limit_exceeded", "too_many_requests"].includes(value))) {
    return "rate_limited";
  }
  if (identifiers.some((value) => ["authentication_error", "unauthorized", "forbidden"].includes(value))) {
    return "auth_unavailable";
  }
  if (
    identifiers.some((value) =>
      ["invalid_request_error", "model_not_found", "unsupported_model"].includes(value)
    )
  ) {
    return "request_rejected";
  }
  if (identifiers.some((value) => ["server_error", "overloaded", "service_unavailable"].includes(value))) {
    return "provider_unavailable";
  }

  const message = metadata.message || "";
  if (looksLikeProviderStreamTermination(message)) {
    return "stream_terminated";
  }
  if (/usage[_ ]limit(?:[_ ]reached| has been reached)|quota[_ ]exhausted/iu.test(message)) {
    return "quota_exhausted";
  }
  if (/rate.?limit|too many requests/iu.test(message)) {
    return "rate_limited";
  }
  if (/servers? (?:are )?(?:currently )?overloaded|try again later|service unavailable/iu.test(message)) {
    return "provider_unavailable";
  }
  if (/unsupported.*model|invalid.*model|model.*not found/iu.test(message)) {
    return "request_rejected";
  }
  if (/unauthori[sz]ed|forbidden|authentication (?:failed|required)/iu.test(message)) {
    return "auth_unavailable";
  }
  return "provider_error";
}

function looksLikeProviderStreamTermination(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    normalized === "terminated"
    || normalized === "this operation was aborted"
    || normalized === "codex oauth stream aborted"
    || normalized.includes("stream terminated")
    || normalized.includes("response terminated")
  );
}

function extractOutputText(payload: CodexResponsesApiResponse): string {
  const parts: string[] = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("").trim();
}

function extractDeltaText(event: CodexResponsesEvent): string {
  const type = normalizeCodexResponsesEventType(event);
  if (type !== "response.output_text.delta") {
    return "";
  }
  return asString(event.delta) || "";
}

function isCodexOAuthSuccessTerminal(event: CodexResponsesEvent): boolean {
  const type = normalizeCodexResponsesEventType(event);
  return (
    type === "response.completed"
    || (
      type === "response.output_item.done"
      && Boolean(extractCodexOAuthCompletedOutputMessageText(event.item))
    )
    || (type === "item.completed" && isCodexOAuthCompletedOutputItem(event.item))
    || (type === "message.completed" && Boolean(extractCodexOAuthCompletedMessageText(event)))
    || type === "response.output_text.done"
  );
}

function isCodexOAuthCompletedOutputItem(item: Record<string, unknown> | undefined): boolean {
  return Boolean(extractCodexOAuthCompletedOutputItemText(item));
}

function extractCompletedTextCandidate(event: CodexResponsesEvent): string | undefined {
  const type = normalizeCodexResponsesEventType(event);

  if (type === "response.completed") {
    return extractOutputText(event.response || {}) || undefined;
  }
  if (type === "response.output_item.done") {
    return extractCodexOAuthCompletedOutputMessageText(event.item);
  }
  if (type === "item.completed") {
    return extractCodexOAuthCompletedOutputItemText(event.item);
  }
  if (type === "message.completed") {
    return extractCodexOAuthCompletedMessageText(event);
  }
  if (type === "response.output_text.done") {
    return asNonEmptyString(event.text) || asNonEmptyString(event.output_text);
  }

  return undefined;
}

function extractCodexOAuthCompletedMessageText(event: CodexResponsesEvent): string | undefined {
  if (event.item) {
    return extractCodexOAuthCompletedOutputItemText(event.item);
  }
  return extractCodexOAuthOutputTextParts(event.content) || asNonEmptyString(event.output_text);
}

function extractCodexOAuthCompletedOutputItemText(
  item: Record<string, unknown> | undefined
): string | undefined {
  if (!item) {
    return undefined;
  }
  const itemType = typeof item.type === "string" ? item.type.trim().toLowerCase() : "";
  if (itemType === "message") {
    return extractCodexOAuthOutputTextParts(item.content);
  }
  if (itemType === "output_text") {
    return asNonEmptyString(item.text) || asNonEmptyString(item.output_text);
  }
  return undefined;
}

function extractCodexOAuthCompletedOutputMessageText(
  item: Record<string, unknown> | undefined
): string | undefined {
  if (!item || item.status !== "completed") {
    return undefined;
  }
  const itemType = typeof item.type === "string" ? item.type.trim().toLowerCase() : "";
  if (itemType !== "message") {
    return undefined;
  }
  return extractCodexOAuthOutputTextParts(item.content);
}

function extractCodexOAuthOutputTextParts(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content.map((part) => {
    if (!part || typeof part !== "object") {
      return "";
    }
    const record = part as Record<string, unknown>;
    const partType = typeof record.type === "string" ? record.type.trim().toLowerCase() : "";
    if (partType !== "output_text") {
      return "";
    }
    return asNonEmptyString(record.text) || asNonEmptyString(record.output_text) || "";
  }).join("").trim();
  return text || undefined;
}

function mergePayload(
  current: CodexResponsesApiResponse,
  next: CodexResponsesApiResponse
): CodexResponsesApiResponse {
  const safeNext: CodexResponsesApiResponse = {
    ...next,
    error: undefined,
    incomplete_details: undefined
  };
  return {
    ...current,
    ...safeNext,
    output: next.output && next.output.length > 0 ? next.output : current.output,
    usage: next.usage || current.usage
  };
}

function rememberCandidateText(target: string[], text: string | undefined): void {
  const trimmed = text?.trim();
  if (trimmed && target.at(-1) !== trimmed) {
    target.push(trimmed);
  }
}

function selectBestText(
  deltaText: string,
  authoritativeFinalText: string,
  candidateTexts: string[]
): string {
  if (authoritativeFinalText) {
    return authoritativeFinalText;
  }

  const latestTerminalCandidate = candidateTexts.at(-1);
  if (latestTerminalCandidate) {
    return latestTerminalCandidate;
  }

  return deltaText.trim();
}

function normalizeCodexResponsesEventType(event: CodexResponsesEvent): string {
  return typeof event.type === "string" ? event.type.trim().toLowerCase() : "";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}
