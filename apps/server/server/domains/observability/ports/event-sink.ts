/**
 * EventSink port: structured, JSON-natural observability records for logs, errors,
 * traces, and domain signals. Adapters (local stdout/JSONL, in-memory, future
 * Postgres) implement this boundary; callers depend on the port, not a backend.
 */

import type { EventRecord } from "@meridian/contracts/observability";

export type {
  EventCorrelation,
  EventLevel,
  EventRecord,
  EventSensitivity,
  TraceStreamRef,
} from "@meridian/contracts/observability";

/**
 * Unified emission port (D15). Every observable signal funnels through one sink
 * so dev (local stdout/JSONL) and prod swaps stay at the composition root.
 */
export interface EventSink {
  emit(event: EventRecord): void;
  emitBatch(events: EventRecord[]): void;
  flush(): Promise<void>;
}
