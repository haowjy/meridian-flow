/**
 * Shared JSON-natural observability vocabulary for client and server event producers.
 * This is distinct from `observation.ts`, which models durable authority causal cuts.
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
  documentId?: string;
  branchId?: string;
  branchGeneration?: number;
  yjsClient?: number;
  /**
   * Canonical Yjs update spans key from `@meridian/yjs-inspect`'s `summarizeUpdate().spansKey`:
   * `s:<client>:<from>-<to>` and `d:<client>:<from>-<to>` tokens joined by `,`.
   * Same-kind span overlap is the client/server join rule (design D2).
   */
  yjsSpans?: string;
}

export interface TraceStreamRef {
  /**
   * Canonical filter key, e.g. `yjs:live:<docId>`, `yjs:branch:<id>:gen:3`,
   * `thread:<threadId>`, or `gateway:<attemptId>`.
   */
  streamId: string;
  transport: "thread-ws" | "yjs" | "gateway";
  /** Absolute, not observer-relative. Omitted for lifecycle events. */
  direction?: "client_to_server" | "server_to_client";
  /** Which process recorded this event. The viewer joins client and server views. */
  observedAt: "client" | "server";
  /**
   * Wire-level message class from the transport's own vocabulary:
   * thread-ws: `event` | `subscribed` | `gap` | `ping` | ...
   * yjs: `sync.step1` | `sync.step2` | `sync.update` | `sync.status` | `awareness` |
   *   `stateless` | `auth` | `close` | `ping` | `pong` | `unknown`
   * gateway: `start` | `text.delta` | `usage` | `end` | `error`
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
  /** Emitting domain or subsystem, e.g. `runtime.orchestrator` or `lib.ws-yjs`. */
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
