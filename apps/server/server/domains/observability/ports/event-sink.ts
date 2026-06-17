/**
 * EventSink port: structured, JSON-natural observability records for logs, errors,
 * traces, and domain signals. Adapters (local stdout/JSONL, in-memory, future
 * Postgres) implement this boundary; callers depend on the port, not a backend.
 */

/** Severity for filtering and routing; mirrors common log levels. */
export type EventLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** Coarse data-safety classification for searchable observability records. */
export type EventSensitivity = "safe" | "protected_reference";

/** Searchable causal pivots shared across request, runtime, and tool events. */
export interface EventCorrelation {
  traceId?: string;
  runId?: string;
  parentRunId?: string;
  requestId?: string;
  threadId?: string;
  turnId?: string;
  childRunId?: string;
  agentSlug?: string;
  iteration?: number;
  attemptId?: string;
  provider?: string;
  model?: string;
  route?: string;
  method?: string;
  projectId?: string;
  workId?: string;
  toolName?: string;
  toolCallId?: string;
  errorCode?: string;
}

/**
 * One structured observability record. All fields are JSON-natural so records
 * survive `JSON.parse(JSON.stringify(x))` unchanged.
 */
export interface EventRecord {
  /** Stable event id generated at emit time when omitted by test fixtures. */
  eventId?: string;
  /** ISO 8601 UTC timestamp when the event occurred. */
  timestamp: string;
  level: EventLevel;
  /** Emitting domain or subsystem, e.g. `runtime.orchestrator` or `lib.ws-yjs`. */
  source: string;
  /** Stable event name within the source, e.g. `tool.output_delta.append_failed`. */
  name: string;
  /** Safe by default; protected payloads are represented by artifact references. */
  sensitivity?: EventSensitivity;
  correlation?: EventCorrelation;
  /** JSON-natural payload bag — safe metadata, error envelopes, and domain fields live here. */
  payload: Record<string, unknown>;
}

/**
 * Unified emission port (D15). Every observable signal funnels through one sink
 * so dev (local stdout/JSONL) and prod swaps stay at the composition root.
 */
export interface EventSink {
  emit(event: EventRecord): void;
  emitBatch(events: EventRecord[]): void;
  flush(): Promise<void>;
}
