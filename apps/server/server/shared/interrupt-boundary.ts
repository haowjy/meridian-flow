/**
 * Purpose: Throws HTTP errors tagged for the Nitro interrupt error handler so the wire body
 * is the shared interrupt envelope, not h3's default `{ status, message, data }` wrapper.
 * Key decisions: envelope lives in `createError.data[HTTP_INTERRUPT_ENVELOPE_KEY]`; the global
 * handler in `interrupt-error-handler.ts` (nitro.config `errorHandler`) unwraps it — mapped
 * routes cannot accidentally serialize the wrapper by forgetting to set response body.
 */
import type { ErrorInterrupt } from "@meridian/contracts/interrupt";
import {
  httpErrorInterruptBody,
  type MeridianError,
  meridianErrorFromHttpStatus,
} from "@meridian/contracts/protocol";
import type { JsonValue } from "@meridian/contracts/threads";
import { createError, HTTPError } from "nitro/h3";

/** Marker key on `createError.data` — consumed only by `interrupt-error-handler.ts`. */
export const HTTP_INTERRUPT_ENVELOPE_KEY = "__meridianInterruptEnvelope";

export function isHttpInterruptEnvelope(data: unknown): data is ErrorInterrupt {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  if (record.kind !== "error" || !record.error || typeof record.error !== "object") return false;
  const error = record.error as Record<string, unknown>;
  return (
    typeof error.code === "string" &&
    typeof error.message === "string" &&
    typeof error.retryable === "boolean" &&
    typeof error.source === "string"
  );
}

export function throwHttpInterrupt(error: MeridianError, statusCode: number): never {
  throw createError({
    statusCode,
    message: error.message,
    data: {
      [HTTP_INTERRUPT_ENVELOPE_KEY]: httpErrorInterruptBody(error),
    },
  });
}

export function throwHttpInterruptForStatus(statusCode: number, message: string): never {
  throwHttpInterrupt(meridianErrorFromHttpStatus(statusCode, message), statusCode);
}

function interruptDetails(data: unknown): JsonValue | undefined {
  if (data === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(data)) as JsonValue;
  } catch {
    return undefined;
  }
}

/**
 * Makes route-owned client refusals final. The durable client queue replays every failure that is
 * not a typed, non-retryable 4xx, so durable-intent routes must classify their own HTTP refusals.
 */
export async function withDurableIntentInterruptBoundary<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!HTTPError.isError(error)) throw error;
    const status = error.status;
    const tagged =
      error.data && typeof error.data === "object" && !Array.isArray(error.data)
        ? (error.data as Record<string, unknown>)[HTTP_INTERRUPT_ENVELOPE_KEY]
        : undefined;
    if (
      isHttpInterruptEnvelope(tagged) ||
      status < 400 ||
      status >= 500 ||
      status === 401 ||
      status === 408 ||
      status === 429
    ) {
      throw error;
    }
    const details = interruptDetails(error.data);
    const mapped = meridianErrorFromHttpStatus(status, error.message);
    throwHttpInterrupt(details === undefined ? mapped : { ...mapped, details }, status);
  }
}
