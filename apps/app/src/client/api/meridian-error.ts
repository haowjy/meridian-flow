/**
 * meridian-error — frontend representation of the canonical `MeridianError` envelope.
 *
 * Purpose: One client-side error type used by both transports (HTTP and WS), so
 * `code`, `retryable`, `source`, and `details` survive the trip from server
 * boundary to UI banner instead of collapsing to a bare `new Error(message)`.
 * Key decision: extend `Error` so existing `onError?: (err: Error) => void`
 * callbacks keep working unchanged — consumers downcast via `isMeridianApiError`
 * to read structured fields.
 */
import { t } from "@lingui/core/macro";
import { isMeridianError, type MeridianError } from "@meridian/contracts/errors";

export class MeridianApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly source: MeridianError["source"];
  readonly details: MeridianError["details"];
  readonly envelope: MeridianError;
  readonly status: number | undefined;
  /** The HTTP response's headers; undefined on the WS path. */
  readonly headers: Headers | undefined;

  constructor(envelope: MeridianError, status?: number, headers?: Headers) {
    super(deletedDestinationCopy(envelope.code, envelope.details) ?? envelope.message);
    this.name = "MeridianApiError";
    this.code = envelope.code;
    this.retryable = envelope.retryable;
    this.source = envelope.source;
    this.details = envelope.details;
    this.envelope = envelope;
    this.status = status;
    this.headers = headers;
  }
}

export function isMeridianApiError(value: unknown): value is MeridianApiError {
  return value instanceof MeridianApiError;
}

/**
 * Parse a server HTTP/WS error payload into a `MeridianApiError`.
 *
 * Accepts either the bare envelope (`{ code, message, retryable, source, ... }`)
 * or the wrapped interrupt body (`{ kind: "error", error: MeridianError }`) so
 * the same helper works for HTTP bodies and WS frames after their type-tag is
 * removed by the caller.
 */
export function meridianApiErrorFromPayload(
  payload: unknown,
  status?: number,
  headers?: Headers,
): MeridianApiError | null {
  if (!payload || typeof payload !== "object") return null;

  if (isMeridianError(payload)) {
    return new MeridianApiError(payload, status, headers);
  }

  const wrapped = payload as { kind?: unknown; error?: unknown };
  if (wrapped.kind === "error" && isMeridianError(wrapped.error)) {
    return new MeridianApiError(wrapped.error, status, headers);
  }

  // Nitro/H3 serializes `createError({ data: envelope })` under `data` while
  // retaining its own status/message fields at the top level.
  const h3 = payload as { data?: unknown };
  if (isMeridianError(h3.data)) {
    return new MeridianApiError(h3.data, status, headers);
  }

  return null;
}

/** Shared across fetch, upload, and command feedback; raw codes never become writer copy. */
export function deletedDestinationCopy(
  code: string,
  details?: MeridianError["details"],
): string | null {
  if (
    code === "project_deleted" ||
    (code === "thread_deleted" &&
      details &&
      typeof details === "object" &&
      !Array.isArray(details) &&
      details.projectDeleted === true)
  )
    return t`This project was deleted.`;
  if (code === "thread_deleted") return t`This chat was deleted.`;
  return null;
}
