/** Barrel: observability domain — EventSink port plus local, deferred, in-memory, and no-op adapters. */

export { DeferredEventSink } from "./adapters/deferred/deferred-event-sink.js";
export {
  createInMemoryEventSink,
  InMemoryEventSink,
} from "./adapters/in-memory/in-memory-event-sink.js";
export {
  createLocalEventSink,
  LocalEventSink,
  type LocalEventSinkOptions,
} from "./adapters/local/local-event-sink.js";
export { createNoopEventSink, NoopEventSink } from "./adapters/noop/noop-event-sink.js";
export { RecentEventsBuffer } from "./adapters/recent/recent-events-buffer.js";
export { createTeeEventSink, TeeEventSink } from "./adapters/tee/tee-event-sink.js";
export { emitEvent, unknownToEventPayload } from "./emit-event.js";
export {
  type EventQuery,
  type EventQueryFilter,
  type EventQueryResult,
  eventMatchesQueryFilter,
} from "./ports/event-query.js";
export type {
  EventCorrelation,
  EventLevel,
  EventRecord,
  EventSensitivity,
  EventSink,
  TraceStreamRef,
} from "./ports/event-sink.js";
export { safeSnippet, sanitizeEventRecord } from "./safe-event.js";
