/**
 * No-op EventSink: satisfies the port without recording or persisting. Useful
 * when a code path requires an EventSink but emission is intentionally disabled.
 */
import type { EventRecord, EventSink } from "../../ports/event-sink.js";

export class NoopEventSink implements EventSink {
  emit(_event: EventRecord): void {
    // intentionally empty
  }

  emitBatch(_events: EventRecord[]): void {
    // intentionally empty
  }

  async flush(): Promise<void> {
    // intentionally empty
  }
}

export function createNoopEventSink(): EventSink {
  return new NoopEventSink();
}
