/**
 * Event-sink factory: resolves Meridian's local observability sink. The default
 * local backend always writes stdout and mirrors to JSONL only when LOG_DIR is set.
 */
import {
  createLocalEventSink,
  createNoopEventSink,
  type EventSink,
} from "../domains/observability/index.js";

export function createEventSinkFromEnv(): EventSink {
  const provider = process.env.EVENT_PROVIDER ?? "local";
  if (provider === "none" || provider === "noop") return createNoopEventSink();
  if (provider === "local") {
    return createLocalEventSink({ dir: process.env.LOG_DIR || undefined });
  }
  throw new Error(`Unsupported EVENT_PROVIDER: ${provider}`);
}
