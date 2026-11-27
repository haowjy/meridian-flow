import { EXPECTED_ACCOUNT_HEADER, WRONG_ACCOUNT_CODE } from "@meridian/contracts/commands";
import { deserializeTransport } from "@meridian/contracts/protocol";

import { isMeridianApiError, meridianApiErrorFromPayload } from "./meridian-error";

export { isMeridianApiError, MeridianApiError } from "./meridian-error";

export class HttpResponseError extends Error {
  readonly name = "HttpResponseError";

  constructor(
    message: string,
    readonly status: number,
    readonly payload: unknown,
    readonly headers?: Headers,
  ) {
    super(message);
  }
}

export class InvalidResponseError extends HttpResponseError {
  readonly code = "malformed_response";
  constructor(response: Response) {
    super("Unexpected server response.", response.status, undefined, response.headers);
  }
}

export type RequestAccount = { id: string; changed: () => void };

let requestAccount: RequestAccount | null = null;

// Kept until the next lifetime mounts, not cleared on unmount: a request sent between one account's close and the next one's mount must be refused, not sent as the cookie's account
export function sendRequestsAs(account: RequestAccount): void {
  requestAccount = account;
}

export function namedAccount(): RequestAccount | null {
  return requestAccount;
}

export function accountHeaders(account: RequestAccount | null): Record<string, string> {
  return account ? { [EXPECTED_ACCOUNT_HEADER]: account.id } : {};
}

export function refusedForAccount(status: number, payload: unknown): boolean {
  return (
    status === 409 && meridianApiErrorFromPayload(payload, status)?.code === WRONG_ACCOUNT_CODE
  );
}

export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const account = requestAccount;
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(accountHeaders(account))) headers.set(name, value);
  const response = await fetch(url, { ...init, headers });
  if (
    response.status === 409 &&
    refusedForAccount(409, await readResponsePayload(response.clone()))
  )
    account?.changed();
  return response;
}

type JsonSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

type JsonOptions<T> = { headers?: HeadersInit; signal?: AbortSignal; schema?: JsonSchema<T> };

function decodeResponse<T>(payload: unknown, response: Response, schema?: JsonSchema<T>): T {
  const value = deserializeTransport(payload);
  if (!schema) return value as T;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new InvalidResponseError(response);
  return parsed.data;
}

export function httpErrorHeaders(error: unknown): Headers | undefined {
  if (error instanceof HttpResponseError) return error.headers;
  return isMeridianApiError(error) ? error.headers : undefined;
}

export function retryAfterMs(error: unknown, now = Date.now()): number | null {
  const value = httpErrorHeaders(error)?.get("Retry-After")?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export function httpErrorStatus(error: unknown): number | undefined {
  if (error instanceof HttpResponseError) return error.status;
  return isMeridianApiError(error) ? error.status : undefined;
}

function errorFromResponse(payload: unknown, response: Response): Error {
  const { status, headers } = response;
  const structured = meridianApiErrorFromPayload(payload, status, headers);
  if (structured) return structured;
  return new HttpResponseError(errorMessageFromPayload(payload, status), status, payload, headers);
}

export async function readResponsePayload(response: Response): Promise<unknown> {
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

export async function getJson<T>(url: string, init?: JsonOptions<T>): Promise<T> {
  const requestInit: RequestInit = { method: "GET" };
  if (init?.headers) {
    requestInit.headers = init.headers;
  }
  if (init?.signal) {
    requestInit.signal = init.signal;
  }

  const response = await apiFetch(url, requestInit);
  const payload = await readResponsePayload(response);

  if (!response.ok) {
    throw errorFromResponse(payload, response);
  }

  return decodeResponse(payload, response, init?.schema);
}

export type PostJsonOptions<T = unknown> = JsonOptions<T> & {
  headers?: HeadersInit;
  keepalive?: boolean;
  signal?: AbortSignal;
};

export async function postJson<T>(
  url: string,
  body: unknown,
  options?: PostJsonOptions<T>,
): Promise<T> {
  const response = await apiFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...options?.headers },
    body: JSON.stringify(body),
    signal: options?.signal,
  });

  const payload = await readResponsePayload(response);

  if (!response.ok) {
    throw errorFromResponse(payload, response);
  }

  return decodeResponse(payload, response, options?.schema);
}

export async function putJson<T>(
  url: string,
  body: unknown,
  options?: PostJsonOptions<T>,
): Promise<T> {
  const response = await apiFetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...options?.headers },
    body: JSON.stringify(body),
    keepalive: options?.keepalive,
  });

  const payload = await readResponsePayload(response);

  if (!response.ok) {
    throw errorFromResponse(payload, response);
  }

  return decodeResponse(payload, response, options?.schema);
}

export async function patchJson<T>(
  url: string,
  body: unknown,
  options?: PostJsonOptions<T>,
): Promise<T> {
  const response = await apiFetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...options?.headers },
    body: JSON.stringify(body),
    signal: options?.signal,
  });

  const payload = await readResponsePayload(response);

  if (!response.ok) {
    throw errorFromResponse(payload, response);
  }

  return decodeResponse(payload, response, options?.schema);
}

export async function deleteRequest(
  url: string,
  init?: { body?: unknown; signal?: AbortSignal },
): Promise<void> {
  const response = await apiFetch(url, {
    method: "DELETE",
    ...(init?.body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }),
    signal: init?.signal,
  });
  if (response.status === 204) return;

  const payload = await readResponsePayload(response);
  if (!response.ok) {
    throw errorFromResponse(payload, response);
  }
}

export async function deleteJson<T>(url: string, options?: JsonOptions<T>): Promise<T> {
  const response = await apiFetch(url, { method: "DELETE", signal: options?.signal });
  const payload = await readResponsePayload(response);
  if (!response.ok) throw errorFromResponse(payload, response);
  return decodeResponse(payload, response, options?.schema);
}
