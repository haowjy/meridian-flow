import type { EventRecord, EventSink } from "../../ports/event-sink.js";
import { sanitizeEventRecord } from "../../safe-event.js";

export class InMemoryEventSink implements EventSink {
  readonly events: EventRecord[] = [];

  emit(event: EventRecord): void {
    this.events.push(sanitizeEventRecord(event));
  }

  emitBatch(events: EventRecord[]): void {
    this.events.push(...events.map(sanitizeEventRecord));
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
