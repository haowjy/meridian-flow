// @ts-nocheck
/**
 * In-memory EventSink for tests: records every emitted event in insertion order
 * so behavioral tests can assert on sink output without touching the filesystem.
 */
import type { EventRecord, EventSink } from "../../ports/event-sink.js";

export class InMemoryEventSink implements EventSink {
  readonly events: EventRecord[] = [];

  emit(event: EventRecord): void {
    this.events.push(event);
  }

  emitBatch(events: EventRecord[]): void {
    this.events.push(...events);
  }

  async flush(): Promise<void> {
    // Nothing buffered asynchronously.
  }

  clear(): void {
    this.events.length = 0;
  }
}

export function createInMemoryEventSink(): InMemoryEventSink {
  return new InMemoryEventSink();
}
