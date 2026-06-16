/**
 * Event-sink factory: resolves Meridian's local JSONL observability sink.
 *
 * The upstream factory also selected external providers. Meridian Flow keeps the
 * same composition seam but avoids provider policy indirection: production code
 * can inject a different EventSink later without route/domain changes.
 */
import {
  createJsonlEventSink,
  createNoopEventSink,
  type EventSink,
} from "../domains/observability/index.js";

export function createEventSinkFromEnv(): EventSink {
  const provider = process.env.EVENT_PROVIDER ?? "local";
  if (provider === "none" || provider === "noop") return createNoopEventSink();
  if (provider === "local") {
    return createJsonlEventSink({ dir: process.env.LOG_DIR ?? "logs" });
  }
  throw new Error(`Unsupported EVENT_PROVIDER: ${provider}`);
}
