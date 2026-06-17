/**
 * Deferred EventSink: process-scoped bootstrap sink that accepts startup and
 * crash diagnostics before the concrete backend is ready, then drains them into
 * the bound local or future durable adapter once app composition finishes.
 */
import type { EventRecord, EventSink } from "../../ports/event-sink.js";
import { sanitizeEventRecord } from "../../safe-event.js";

const MAX_BUFFERED_EVENTS = 1_000;

export class DeferredEventSink implements EventSink {
  private delegate: EventSink | null = null;
  private readonly buffered: EventRecord[] = [];

  bind(delegate: EventSink): void {
    if (this.delegate === delegate) return;
    this.delegate = delegate;
    if (this.buffered.length > 0) {
      delegate.emitBatch(this.buffered.splice(0));
    }
  }

  emit(event: EventRecord): void {
    const sanitized = sanitizeEventRecord(event);
    if (this.delegate) {
      this.delegate.emit(sanitized);
      return;
    }
    this.buffered.push(sanitized);
    if (this.buffered.length > MAX_BUFFERED_EVENTS) this.buffered.shift();
  }

  emitBatch(events: EventRecord[]): void {
    for (const event of events) this.emit(event);
  }

  async flush(): Promise<void> {
    await this.delegate?.flush();
  }
}
