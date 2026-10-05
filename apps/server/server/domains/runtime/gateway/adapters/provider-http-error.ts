/**
 * Shared provider SDK error mapping: one HTTP-status retry policy for every adapter,
 * the provider's retry headers, and the provider's own response (status, message, capped
 * body) as debug evidence.
 *
 * Retry policy: network errors, status-less SDK failures, 408, 429 and 5xx retry. Every
 * other 4xx is the provider refusing this request (402 out of balance, 404 unknown
 * model, 413/422 rejected payload); sending it again gets the same answer.
 */
import { providerErrorResponse } from "@meridian/contracts/threads";
import type { ErrorCode, ProviderErrorResponse } from "../domain/index.js";

type MappedProviderError = {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  providerResponse?: ProviderErrorResponse;
};

/** Both matched against the lowercased 400 message. */
export type ProviderErrorPatterns = {
  contextOverflow: RegExp;
  contentFiltered: RegExp;
};

/** Every provider's context-window and content-filter wording; an adapter overrides only what differs. */
const DEFAULT_PATTERNS: ProviderErrorPatterns = {
  contextOverflow:
    /context[_ ](?:length|window)|exceeds? context limit|prompt is too long|maximum context length|too many (?:input )?tokens|input.*exceeds.*token/,
  contentFiltered: /content[\s\S]*filter|filter[\s\S]*content/,
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function header(headers: unknown, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const values = record(headers);
  if (!values) return undefined;
  const key = Object.keys(values).find((candidate) => candidate.toLowerCase() === name);
  const value = key ? values[key] : undefined;
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function retryAfterMs(headers: unknown, now: number): number | undefined {
  const milliseconds = header(headers, "retry-after-ms");
  if (milliseconds !== undefined) {
    const value = Number(milliseconds);
    if (Number.isFinite(value) && value >= 0) return Math.round(value);
  }

  const retryAfter = header(headers, "retry-after");
  if (retryAfter === undefined) return undefined;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1_000) : undefined;
  const date = Date.parse(retryAfter);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function responseHeaders(err: unknown): unknown {
  const errorRecord = record(err);
  return errorRecord?.headers ?? record(errorRecord?.response)?.headers;
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
  const rawBody =
    exactFailureBody(err) ??
    (parsed === undefined ? message : typeof parsed === "string" ? parsed : JSON.stringify(parsed));
  return providerErrorResponse({ status: status ?? null, message: providerMessage, rawBody });
}

export function mapProviderHttpError(
  err: unknown,
  overrides: Partial<ProviderErrorPatterns> = {},
): MappedProviderError {
  const patterns = { ...DEFAULT_PATTERNS, ...overrides };
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
      if (patterns.contentFiltered.test(lower)) {
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
  const headers = responseHeaders(err);
  const retryAfter = retryAfterMs(headers, Date.now());
  const shouldRetry = header(headers, "x-should-retry")?.trim().toLowerCase();
  return {
    ...mapped,
    ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
    ...(shouldRetry === "false" ? { retryable: false } : {}),
    ...(providerResponse ? { providerResponse } : {}),
  };
}
