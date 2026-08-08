/** TeeEventSink: synchronous event fan-out to composed observability adapters. */
import type { EventRecord, EventSink } from "../../ports/event-sink.js";

export class TeeEventSink implements EventSink {
  constructor(private readonly sinks: readonly EventSink[]) {}

  emit(event: EventRecord): void {
    for (const sink of this.sinks) {
      try {
        sink.emit(event);
      } catch {
        // One diagnostic adapter cannot veto the operation or starve siblings.
      }
    }
  }

  emitBatch(events: EventRecord[]): void {
    for (const sink of this.sinks) {
      try {
        sink.emitBatch(events);
      } catch {
        // One diagnostic adapter cannot veto the operation or starve siblings.
      }
    }
  }

  async flush(): Promise<void> {
    await Promise.all(
      this.sinks.map(async (sink) => {
        try {
          await sink.flush();
        } catch {
          // One adapter cannot veto flushing the other evidence backends.
        }
      }),
    );
  }
}

export function createTeeEventSink(sinks: readonly EventSink[]): EventSink {
  return new TeeEventSink(sinks);
}
