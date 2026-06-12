/**
 * Purpose: Nitro global error handler that unwraps interrupt-tagged HTTP errors into the
 * canonical `{ kind: "error", error }` body (same arm WS error frames embed).
 * Key decisions: registered first in `nitro.config.ts` `errorHandler` so every mapped route
 * that calls `throwHttpInterrupt*` gets envelope-shaped JSON without per-handler discipline;
 * non-interrupt errors fall through to Nitro's built-in handler.
 */
import { HTTPError } from "nitro/h3";
import { HTTP_INTERRUPT_ENVELOPE_KEY, isHttpInterruptEnvelope } from "./interrupt-boundary.js";

export default function interruptErrorHandler(
  error: unknown,
  _event: unknown,
  _context?: { defaultHandler?: (error: unknown, event: unknown) => unknown },
): Response | undefined {
  if (!HTTPError.isError(error)) return undefined;

  const data = error.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;

  const envelope = (data as Record<string, unknown>)[HTTP_INTERRUPT_ENVELOPE_KEY];
  if (!isHttpInterruptEnvelope(envelope)) return undefined;

  return new Response(JSON.stringify(envelope), {
    status: error.status ?? 500,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
