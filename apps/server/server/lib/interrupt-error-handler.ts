import { HTTPError } from "nitro/h3";
import {
  HTTP_INTERRUPT_ENVELOPE_KEY,
  isHttpInterruptEnvelope,
} from "../shared/interrupt-boundary.js";

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
