// @ts-nocheck
/**
 * EventSink port: structured, JSON-natural observability records for logs, errors,
 * traces, and domain signals. Adapters (JSONL file, in-memory, future Postgres)
 * implement this boundary; callers depend on the port, not a concrete backend.
 *
 * P1c ships a minimal record shape. Retention classes, correlation ids, and the
 * full D15 `Event` discriminant land in later waves — payloads stay generic so
 * envelopes like `MeridianError` flow through unchanged when wired.
 */

/** Severity for filtering and routing; mirrors common log levels. */
export type EventLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/**
 * One structured observability record. All fields are JSON-natural (strings,
 * plain objects) so records survive `JSON.parse(JSON.stringify(x))` unchanged.
 */
export interface EventRecord {
  /** ISO 8601 UTC timestamp when the event occurred. */
  timestamp: string;
  level: EventLevel;
  /** Emitting domain or subsystem, e.g. `runtime.orchestrator` or `lib.ws-yjs`. */
  source: string;
  /** Stable event name within the source, e.g. `tool.output_delta.append_failed`. */
  name: string;
  /** JSON-natural payload bag — error envelopes and domain fields live here. */
  payload: Record<string, unknown>;
}

/**
 * Unified emission port (D15). Every observable signal funnels through one sink
 * so dev (JSONL) and prod (Postgres) swaps stay at the composition root.
 */
export interface EventSink {
  emit(event: EventRecord): void;
  emitBatch(events: EventRecord[]): void;
  flush(): Promise<void>;
}
