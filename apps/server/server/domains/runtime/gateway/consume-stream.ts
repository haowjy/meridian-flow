/**
 * Stream consumption helper: drains a provider adapter's StreamEvent iterable
 * into a final GenerateResult and defines GatewayStreamError. Owns the
 * stream->result reduction shared by every adapter; depends only on domain types.
 *
 * This is the synchronous convenience wrapper for callers that don't need
 * streaming deltas. It iterates the full stream, discarding intermediate
 * deltas, and either returns the final GenerateResult or throws on error.
 */
import type { GenerateResult, StreamEvent } from "./domain/index.js";

export class GatewayStreamError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GatewayStreamError";
  }
}

/**
 * Collect a canonical stream into a GenerateResult (for generate()).
 *
 * Iterates all events, ignoring intermediate deltas. The "end" event carries
 * the complete GenerateResult. Error events are thrown as GatewayStreamError
 * so the caller can distinguish provider errors from stream corruption.
 *
 * If the stream terminates without an "end" event (malformed provider output),
 * throws a plain Error. This should not happen with well-behaved adapters.
 */
export async function consumeStream(events: AsyncIterable<StreamEvent>): Promise<GenerateResult> {
  let result: GenerateResult | undefined;

  for await (const event of events) {
    if (event.type === "end") {
      result = event.result;
    }
    if (event.type === "error") {
      throw new GatewayStreamError(event.code, event.message, event.retryable);
    }
  }

  if (!result) {
    throw new Error("Stream ended without a result event");
  }
  return result;
}
