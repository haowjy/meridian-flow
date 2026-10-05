/**
 * Shared provider SDK error mapping: one HTTP-status retry policy for every adapter,
 * plus the provider's own response (status, message, capped body) as debug evidence.
 *
 * Retry policy: network errors, status-less SDK failures, 408, 429 and 5xx retry. Every
 * other 4xx is the provider refusing this request (402 out of balance, 404 unknown
 * model, 413/422 rejected payload); sending it again gets the same answer.
 */
import { providerErrorResponse } from "@meridian/contracts/threads";
import type { ErrorCode, ProviderErrorResponse } from "../domain/index.js";
import { withProviderRetryMetadata } from "./provider-error-metadata.js";

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

// SDKs parse failure bodies and keep only part (OpenAI keeps `body.error`). The
// SDK error carries the same Headers object as the Response, so it keys the text.
const failureBodies = new WeakMap<Headers, string>();

/** `fetch` for provider SDK clients: records each failed response's exact body text. */
export const providerFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (!response.ok) {
    try {
      failureBodies.set(response.headers, await response.clone().text());
    } catch {
      // An unreadable body leaves the SDK's parsed view as the evidence.
    }
  }
  return response;
};

function exactFailureBody(err: unknown): string | undefined {
  const headers = record(err)?.headers;
  return headers instanceof Headers ? failureBodies.get(headers) : undefined;
}

/**
 * The provider's response: the exact body text when the client used `providerFetch`,
 * otherwise the SDK's parsed view (OpenAI-shaped SDKs keep the body's `error`
 * object, Anthropic the whole body). Absent when the SDK never received a response.
 */
function providerResponseOf(err: unknown): ProviderErrorResponse | undefined {
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
  let body = exactFailureBody(err);
  if (body === undefined && parsed === undefined) body = message;
  else if (body === undefined) body = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
  return providerErrorResponse({
    status: status ?? null,
    message: providerMessage,
    rawBody: body ?? message,
  });
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
    if (status === 408) return { code: "network_error", message, retryable: true };
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
  const providerResponse = providerResponseOf(err);
  return withProviderRetryMetadata(err, {
    ...mapped,
    ...(providerResponse ? { providerResponse } : {}),
  });
}
