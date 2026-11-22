/**
 * Shared JSON-natural observability vocabulary for client and server event producers.
 * These contracts describe diagnostic events, not document provenance authority.
 * Server emitters must populate `stream.observedAt: "server"` and reuse these key names verbatim.
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
  /** One logical gateway call: a `stream()`/`generate()` invocation including internal retries. */
  gatewayCallId?: string;
  provider?: string;
  model?: string;
  route?: string;
  method?: string;
  projectId?: string;
  workId?: string;
  toolName?: string;
  toolCallId?: string;
  errorCode?: string;
  documentId?: string;
  draftId?: string;
  /** Comma-joined ids (at most three; see `joinIds`). */
  folderIds?: string;
  /**
   * A Loro room batch: a `DocUpdate`'s `batchId`, or the `refId` of the `Ack` that answers it.
   * The client and server records of one batch share it.
   */
  batchId?: string;
}

export interface TraceStreamRef {
  /**
   * Canonical filter key, e.g. `loro:live:<docId>`, `loro:tree:project:<id>`,
   * `thread:<threadId>`, or `gateway:<gatewayCallId>`.
   */
  streamId: string;
  transport: "thread" | "loro" | "gateway";
  /** Absolute, not observer-relative. Omitted for lifecycle events. */
  direction?: "client_to_server" | "server_to_client";
  /** Which process recorded this event. The viewer joins client and server views. */
  observedAt: "client" | "server";
  /**
   * Wire-level message class from the transport's own vocabulary:
   * thread: `event` | `subscribed` | `gap` | `ping` | ...
   * loro: `join.request` | `join.ok` | `join.error` | `update` | `update.fragment_header` |
   *   `update.fragment` | `room.error` | `leave` | `ack` | `socket.open` | `socket.close`
   * gateway: `start` | `text.delta` | `reasoning.delta` | `tool_call.delta` |
   *   `usage` | `end` | `error`
   */
  messageClass?: string;
  bytes?: number;
  /** Monotonic per-observer sequence for stable ordering in the viewer. */
  observerSeq: number;
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
  /** Emitting domain or subsystem, e.g. `runtime.orchestrator` or `wire.loro`. */
  source: string;
  /** Stable event name within the source, e.g. `tool.output_delta.append_failed`. */
  name: string;
  /** Safe by default; protected payloads are represented by artifact references. */
  sensitivity?: EventSensitivity;
  correlation?: EventCorrelation;
  stream?: TraceStreamRef;
  /** JSON-natural payload bag — safe metadata, error envelopes, and domain fields live here. */
  payload: Record<string, unknown>;
}
