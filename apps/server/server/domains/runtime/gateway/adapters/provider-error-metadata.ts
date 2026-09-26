/** Extract canonical retry metadata from provider SDK response headers. */

type RetryableError = { retryable: boolean };

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

function responseHeaders(error: unknown): unknown {
  const errorRecord = record(error);
  return errorRecord?.headers ?? record(errorRecord?.response)?.headers;
}

export function withProviderRetryMetadata<T extends RetryableError>(
  error: unknown,
  mapped: T,
): T & { retryAfterMs?: number } {
  const headers = responseHeaders(error);
  const retryAfter = retryAfterMs(headers, Date.now());
  const shouldRetry = header(headers, "x-should-retry")?.trim().toLowerCase();
  return {
    ...mapped,
    ...(retryAfter === undefined ? {} : { retryAfterMs: retryAfter }),
    ...(shouldRetry === "false" ? { retryable: false } : {}),
  };
}
