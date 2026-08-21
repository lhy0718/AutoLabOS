export type CodexOAuthCompletionErrorCode =
  | "auth_unavailable"
  | "request_rejected"
  | "quota_exhausted"
  | "rate_limited"
  | "transport_error"
  | "provider_unavailable"
  | "stream_terminated"
  | "provider_error"
  | "incomplete_response"
  | "empty_response"
  | "input_unavailable"
  | "observer_error";

export type CodexOAuthRetryDisposition =
  | "operator_action"
  | "backoff"
  | "caller_recovery"
  | "none";

const COMPLETION_ERROR_CODES: readonly CodexOAuthCompletionErrorCode[] = [
  "auth_unavailable",
  "request_rejected",
  "quota_exhausted",
  "rate_limited",
  "transport_error",
  "provider_unavailable",
  "stream_terminated",
  "provider_error",
  "incomplete_response",
  "empty_response",
  "input_unavailable",
  "observer_error"
];

const SAFE_COMPLETION_ERROR_DETAILS: Record<CodexOAuthCompletionErrorCode, string> = {
  auth_unavailable: "Authentication is unavailable. Run `codex login` and retry.",
  request_rejected: "The provider rejected the request. Check the configured model and request settings.",
  quota_exhausted: "The account usage limit is exhausted. Retry after the provider limit resets.",
  rate_limited: "The provider temporarily rate limited the request. Retry later.",
  transport_error: "The provider could not be reached. Check network connectivity and retry.",
  provider_unavailable: "The provider is temporarily unavailable. Retry later.",
  stream_terminated: "The provider terminated the response before completion.",
  provider_error: "The provider returned an unspecified failure.",
  incomplete_response: "The provider ended the response before completing it.",
  empty_response: "The provider returned no usable text.",
  input_unavailable: "A local completion input could not be prepared. Check the referenced input and retry.",
  observer_error: "The local completion progress observer failed."
};

const COMPLETION_ERROR_RETRY_DISPOSITIONS: Record<
  CodexOAuthCompletionErrorCode,
  CodexOAuthRetryDisposition
> = {
  auth_unavailable: "operator_action",
  request_rejected: "caller_recovery",
  quota_exhausted: "operator_action",
  rate_limited: "backoff",
  transport_error: "backoff",
  provider_unavailable: "backoff",
  stream_terminated: "caller_recovery",
  provider_error: "none",
  incomplete_response: "caller_recovery",
  empty_response: "none",
  input_unavailable: "caller_recovery",
  observer_error: "none"
};

export class CodexOAuthCompletionError extends Error {
  readonly provider = "codex_oauth" as const;
  readonly retryDisposition: CodexOAuthRetryDisposition;
  readonly retryable: boolean;

  constructor(readonly code: CodexOAuthCompletionErrorCode) {
    super(`Codex OAuth completion failed [codex_oauth:${code}]. ${SAFE_COMPLETION_ERROR_DETAILS[code]}`);
    this.name = "CodexOAuthCompletionError";
    this.retryDisposition = COMPLETION_ERROR_RETRY_DISPOSITIONS[code];
    this.retryable = this.retryDisposition === "backoff";
  }
}

export function isCodexOAuthCompletionError(error: unknown): error is CodexOAuthCompletionError {
  return error instanceof CodexOAuthCompletionError;
}

export function parseCodexOAuthCompletionErrorCode(
  value: string
): CodexOAuthCompletionErrorCode | undefined {
  const match = value.toLowerCase().match(/\bcodex_oauth:([a-z_]+)\b/u);
  const candidate = match?.[1] as CodexOAuthCompletionErrorCode | undefined;
  return candidate && COMPLETION_ERROR_CODES.includes(candidate) ? candidate : undefined;
}

export function makeCodexOAuthAbortError(): Error {
  const error = new Error("Codex OAuth operation aborted by user.");
  error.name = "AbortError";
  return error;
}
