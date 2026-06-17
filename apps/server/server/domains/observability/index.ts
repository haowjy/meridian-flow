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
export { emitEvent, unknownToEventPayload } from "./emit-event.js";
export type {
  EventCorrelation,
  EventLevel,
  EventRecord,
  EventSensitivity,
  EventSink,
} from "./ports/event-sink.js";
export { safeSnippet, sanitizeEventRecord } from "./safe-event.js";
