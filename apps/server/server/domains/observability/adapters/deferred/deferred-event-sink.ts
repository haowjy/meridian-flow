/**
 * Deferred EventSink: process-scoped bootstrap sink that accepts startup and
 * crash diagnostics before the concrete backend is ready, then drains them into
 * the bound local or future durable adapter once app composition finishes.
 */
import type { EventRecord, EventSink } from "../../ports/event-sink.js";
import { sanitizeEventRecord, serializedEventBytes } from "../../safe-event.js";

const MAX_BUFFERED_EVENTS = 1_000;
const MAX_BUFFERED_BYTES = 4 * 1_024 * 1_024;

export class DeferredEventSink implements EventSink {
  private delegate: EventSink | null = null;
  private readonly buffered: EventRecord[] = [];
  private bufferedBytes = 0;
  private droppedRecords = 0;
  private droppedBytes = 0;

  bind(delegate: EventSink): void {
    if (this.delegate === delegate) return;
    this.delegate = delegate;
    if (this.buffered.length > 0) {
      const events = this.buffered.splice(0);
      this.bufferedBytes = 0;
      if (this.droppedRecords > 0) {
        events.unshift({
          eventId: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          level: "warn",
          source: "observability",
          name: "bootstrap.dropped",
          sensitivity: "safe",
          payload: { droppedRecords: this.droppedRecords, droppedBytes: this.droppedBytes },
        });
        this.droppedRecords = 0;
        this.droppedBytes = 0;
      }
      delegate.emitBatch(events);
    }
  }

  emit(event: EventRecord): void {
    const sanitized = sanitizeEventRecord(event);
    if (this.delegate) {
      this.delegate.emit(sanitized);
      return;
    }
    this.buffered.push(sanitized);
    this.bufferedBytes += serializedEventBytes(sanitized);
    while (this.buffered.length > MAX_BUFFERED_EVENTS || this.bufferedBytes > MAX_BUFFERED_BYTES) {
      const dropped = this.buffered.shift();
      if (!dropped) break;
      const bytes = serializedEventBytes(dropped);
      this.bufferedBytes -= bytes;
      this.droppedRecords += 1;
      this.droppedBytes += bytes;
    }
  }

  emitBatch(events: EventRecord[]): void {
    for (const event of events) this.emit(event);
  }

  async flush(): Promise<void> {
    await this.delegate?.flush();
  }
}
