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
import { isMeridianError, type MeridianError } from "@meridian/contracts/interrupt";

export class MeridianApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly source: MeridianError["source"];
  readonly details: MeridianError["details"];
  readonly envelope: MeridianError;
  readonly status: number | undefined;

  constructor(envelope: MeridianError, status?: number) {
    super(envelope.message);
    this.name = "MeridianApiError";
    this.code = envelope.code;
    this.retryable = envelope.retryable;
    this.source = envelope.source;
    this.details = envelope.details;
    this.envelope = envelope;
    this.status = status;
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
): MeridianApiError | null {
  if (!payload || typeof payload !== "object") return null;

  if (isMeridianError(payload)) {
    return new MeridianApiError(payload, status);
  }

  const wrapped = payload as { kind?: unknown; error?: unknown };
  if (wrapped.kind === "error" && isMeridianError(wrapped.error)) {
    return new MeridianApiError(wrapped.error, status);
  }

  return null;
}
