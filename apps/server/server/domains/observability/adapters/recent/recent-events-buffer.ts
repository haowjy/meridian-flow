/** RecentEventsBuffer: bounded in-memory history and live query over safe event snapshots. */
import {
  type EventQuery,
  type EventQueryFilter,
  type EventQueryResult,
  eventMatchesQueryFilter,
} from "../../ports/event-query.js";
import type { EventRecord, EventSink } from "../../ports/event-sink.js";
import { serializedEventBytes } from "../../safe-event.js";

const DEFAULT_CAPACITY = 5_000;
const DEFAULT_BYTE_CAPACITY = 16 * 1_024 * 1_024;
const DEFAULT_QUERY_LIMIT = 200;

export class RecentEventsBuffer implements EventSink, EventQuery {
  private readonly capacity: number;
  private readonly byteCapacity: number;
  private readonly records: Array<EventRecord | undefined>;
  private readonly recordBytes: number[];
  private readonly listeners = new Set<(event: EventRecord) => void>();
  private head = 0;
  private size = 0;
  private dropped = 0;
  private retainedBytes = 0;
  private droppedBytes = 0;

  constructor(capacity = DEFAULT_CAPACITY, byteCapacity = DEFAULT_BYTE_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("RecentEventsBuffer capacity must be a positive integer");
    }
    if (!Number.isInteger(byteCapacity) || byteCapacity < 1) {
      throw new Error("RecentEventsBuffer byteCapacity must be a positive integer");
    }
    this.capacity = capacity;
    this.byteCapacity = byteCapacity;
    this.records = new Array(capacity);
    this.recordBytes = new Array(capacity).fill(0);
  }

  emit(event: EventRecord): void {
    const bytes = serializedEventBytes(event);
    while (
      this.size > 0 &&
      (this.size === this.capacity || this.retainedBytes + bytes > this.byteCapacity)
    ) {
      this.evictOldest();
    }
    const index = (this.head + this.size) % this.capacity;
    this.records[index] = event;
    this.recordBytes[index] = bytes;
    this.retainedBytes += bytes;
    this.size += 1;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A debug consumer cannot break the application emission path.
      }
    }
  }

  emitBatch(events: EventRecord[]): void {
    for (const event of events) this.emit(event);
  }

  async flush(): Promise<void> {
    // Nothing buffered asynchronously.
  }

  query(filter: EventQueryFilter): EventQueryResult {
    const limit = filter.limit ?? DEFAULT_QUERY_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) {
      return { events: [], dropped: this.dropped, droppedBytes: this.droppedBytes };
    }

    const events: EventRecord[] = [];
    for (let offset = this.size - 1; offset >= 0; offset -= 1) {
      const index = (this.head + offset) % this.capacity;
      const event = this.records[index];
      if (!event) continue;
      if (filter.sinceEventId !== undefined && event.eventId === filter.sinceEventId) break;
      if (!eventMatchesQueryFilter(event, filter)) continue;
      events.push(event);
      if (events.length >= limit) break;
    }
    return { events, dropped: this.dropped, droppedBytes: this.droppedBytes };
  }

  subscribe(listener: (event: EventRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private evictOldest(): void {
    const bytes = this.recordBytes[this.head] ?? 0;
    this.records[this.head] = undefined;
    this.recordBytes[this.head] = 0;
    this.head = (this.head + 1) % this.capacity;
    this.size -= 1;
    this.retainedBytes -= bytes;
    this.dropped += 1;
    this.droppedBytes += bytes;
  }
}
