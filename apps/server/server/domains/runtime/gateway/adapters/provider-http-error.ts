/**
 * Shared provider SDK error mapping: one HTTP-status retry policy for every adapter,
 * plus the provider's own response (status, message, capped body) as debug evidence.
 *
 * Retry policy: network errors, status-less SDK failures, 429 and 5xx retry. Every
 * other 4xx is the provider refusing this request (402 out of balance, 404 unknown
 * model, 413/422 rejected payload); sending it again gets the same answer.
 */
import type { ErrorCode, ProviderErrorResponse } from "../domain/index.js";
import { withProviderRetryMetadata } from "./provider-error-metadata.js";

/** Bound on the stored provider body; error bodies are small unless a proxy returns HTML. */
export const PROVIDER_ERROR_BODY_LIMIT = 4_096;

export type MappedProviderError = {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  providerResponse?: ProviderErrorResponse;
};

export type ProviderErrorPatterns = {
  /** Matched against the lowercased 400 message. */
  contextOverflow: RegExp;
  contentFiltered: (lowerMessage: string) => boolean;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function httpStatus(err: unknown): number | undefined {
  const status = record(err)?.status;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  const message = record(err)?.message;
  return message !== undefined ? String(message) : String(err);
}

function capBody(text: string): string {
  return text.length > PROVIDER_ERROR_BODY_LIMIT ? text.slice(0, PROVIDER_ERROR_BODY_LIMIT) : text;
}

/**
 * The provider's response as the SDK parsed it. OpenAI-shaped SDKs keep the body's
 * `error` object; Anthropic keeps the whole body; a non-JSON body survives only as
 * the SDK message. Absent when the SDK never received a response.
 */
export function providerErrorResponse(err: unknown): ProviderErrorResponse | undefined {
  const status = httpStatus(err);
  const parsed = record(err)?.error;
  if (status === undefined && parsed === undefined) return undefined;
  const message = errorMessage(err);
  const nested = record(parsed);
  const providerMessage =
    typeof nested?.message === "string"
      ? nested.message
      : typeof record(nested?.error)?.message === "string"
        ? String(record(nested?.error)?.message)
        : message;
  let body: string;
  if (parsed === undefined) body = message;
  else if (typeof parsed === "string") body = parsed;
  else body = JSON.stringify(parsed) ?? message;
  return { status: status ?? null, message: providerMessage, body: capBody(body) };
}

export function mapProviderHttpError(
  err: unknown,
  patterns: ProviderErrorPatterns,
): MappedProviderError {
  const status = httpStatus(err);
  const message = errorMessage(err);
  const mapped: { code: ErrorCode; message: string; retryable: boolean } = (() => {
    if (status === 401 || status === 403) {
      return { code: "auth_error", message, retryable: false };
    }
    if (status === 429) return { code: "rate_limited", message, retryable: true };
    if (status === 400) {
      const lower = message.toLowerCase();
      if (patterns.contextOverflow.test(lower)) {
        return { code: "context_overflow", message, retryable: false };
      }
      if (patterns.contentFiltered(lower)) {
        return { code: "content_filtered", message, retryable: false };
      }
      return { code: "invalid_request", message, retryable: false };
    }
    if (status !== undefined && status >= 500) {
      return { code: "server_error", message, retryable: true };
    }
    if (status !== undefined && status >= 400) {
      return { code: "provider_error", message, retryable: false };
    }
    if (err instanceof TypeError || message.includes("fetch")) {
      return { code: "network_error", message, retryable: true };
    }
    return { code: "provider_error", message, retryable: true };
  })();
  const providerResponse = providerErrorResponse(err);
  return withProviderRetryMetadata(err, {
    ...mapped,
    ...(providerResponse ? { providerResponse } : {}),
  });
}
