/** Barrel: observability domain — EventSink port plus JSONL, in-memory, and no-op adapters. */

export {
  createInMemoryEventSink,
  InMemoryEventSink,
} from "./adapters/in-memory/in-memory-event-sink.js";
export {
  createJsonlEventSink,
  JsonlEventSink,
  type JsonlEventSinkOptions,
} from "./adapters/jsonl/jsonl-event-sink.js";
export { createNoopEventSink, NoopEventSink } from "./adapters/noop/noop-event-sink.js";
export { emitEvent, unknownToEventPayload } from "./emit-event.js";
export type { EventLevel, EventRecord, EventSink } from "./ports/event-sink.js";
