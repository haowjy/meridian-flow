/**
 * http-client — shared fetch helpers for the app's API calls.
 *
 * Response payload parsing, error-message extraction, and typed
 * `getJson`/`postJson`/`deleteRequest` wrappers (proxy to `apps/server`). The
 * single low-level HTTP surface the other `*-api.ts` modules build on.
 *
 * Key decision: failure paths throw `MeridianApiError` so the structured
 * envelope (`code`, `retryable`, `source`, `details`) survives to the UI
 * banner. The same error type is used by the WS dispatcher — one client-side
 * error type for both transports.
 */
import { deserializeTransport } from "@meridian/contracts/protocol";

import { meridianApiErrorFromPayload } from "./meridian-error";

export { isMeridianApiError, MeridianApiError } from "./meridian-error";

/**
 * Build the error thrown for a non-OK response. Prefers the structured
 * `MeridianError` envelope when the server sends one (top-level or wrapped as
 * `{ kind: "error", error }`), so consumers can read `code`/`retryable`/
 * `source`. Falls back to a generic `Error` only when no envelope is present.
 */
function errorFromResponse(payload: unknown, status: number): Error {
  const structured = meridianApiErrorFromPayload(payload);
  if (structured) return structured;
  return new Error(errorMessageFromPayload(payload, status));
}

export async function readResponsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function errorMessageFromPayload(payload: unknown, status: number): string {
  if (payload && typeof payload === "object" && "message" in payload) {
    const { message } = payload as { message?: unknown };
    if (typeof message === "string" && message) return message;
  }
  if (typeof payload === "string" && payload) return payload;
  return `Request failed: ${status}`;
}

export async function getJson<T>(url: string, init?: { headers?: HeadersInit }): Promise<T> {
  const requestInit: RequestInit = { method: "GET" };
  if (init?.headers) {
    requestInit.headers = init.headers;
  }

  const response = await fetch(url, requestInit);
  const payload = await readResponsePayload(response);

  if (!response.ok) {
    throw errorFromResponse(payload, response.status);
  }

  return deserializeTransport<T>(payload as T);
}

export type PostJsonOptions = {
  /** Extra headers to merge with the default Content-Type. */
  headers?: HeadersInit;
  /** Treat these HTTP statuses as success (e.g. 409 already_active). */
  acceptStatuses?: number[];
  /** Allow lifecycle flushes to outlive the page that initiated them. */
  keepalive?: boolean;
};

export async function postJson<T>(
  url: string,
  body: unknown,
  options?: PostJsonOptions,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...options?.headers },
    body: JSON.stringify(body),
  });

  const payload = await readResponsePayload(response);
  const accepted = response.ok || (options?.acceptStatuses?.includes(response.status) ?? false);

  if (!accepted) {
    throw errorFromResponse(payload, response.status);
  }

  return deserializeTransport<T>(payload as T);
}

export async function putJson<T>(
  url: string,
  body: unknown,
  options?: PostJsonOptions,
): Promise<T> {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...options?.headers },
    body: JSON.stringify(body),
    keepalive: options?.keepalive,
  });

  const payload = await readResponsePayload(response);
  const accepted = response.ok || (options?.acceptStatuses?.includes(response.status) ?? false);

  if (!accepted) {
    throw errorFromResponse(payload, response.status);
  }

  return deserializeTransport<T>(payload as T);
}

export async function patchJson<T>(
  url: string,
  body: unknown,
  options?: PostJsonOptions,
): Promise<T> {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...options?.headers },
    body: JSON.stringify(body),
  });

  const payload = await readResponsePayload(response);
  const accepted = response.ok || (options?.acceptStatuses?.includes(response.status) ?? false);

  if (!accepted) {
    throw errorFromResponse(payload, response.status);
  }

  return deserializeTransport<T>(payload as T);
}

export async function deleteRequest(url: string): Promise<void> {
  const response = await fetch(url, { method: "DELETE" });
  if (response.status === 204) return;

  const payload = await readResponsePayload(response);
  if (!response.ok) {
    throw errorFromResponse(payload, response.status);
  }
}
