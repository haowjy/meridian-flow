/** TeeEventSink: synchronous event fan-out to composed observability adapters. */
import type { EventRecord, EventSink } from "../../ports/event-sink.js";

export class TeeEventSink implements EventSink {
  constructor(private readonly sinks: readonly EventSink[]) {}

  emit(event: EventRecord): void {
    for (const sink of this.sinks) sink.emit(event);
  }

  emitBatch(events: EventRecord[]): void {
    for (const sink of this.sinks) sink.emitBatch(events);
  }

  async flush(): Promise<void> {
    await Promise.all(this.sinks.map((sink) => sink.flush()));
  }
}

export function createTeeEventSink(sinks: readonly EventSink[]): EventSink {
  return new TeeEventSink(sinks);
}
