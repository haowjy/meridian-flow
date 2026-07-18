/** RecentEventsBuffer: sanitized, bounded in-memory history and live event query adapter. */
import {
  type EventQuery,
  type EventQueryFilter,
  type EventQueryResult,
  eventMatchesQueryFilter,
} from "../../ports/event-query.js";
import type { EventRecord, EventSink } from "../../ports/event-sink.js";
import { sanitizeEventRecord } from "../../safe-event.js";

const DEFAULT_CAPACITY = 5_000;
const DEFAULT_QUERY_LIMIT = 200;

export class RecentEventsBuffer implements EventSink, EventQuery {
  private readonly capacity: number;
  private readonly records: Array<EventRecord | undefined>;
  private readonly listeners = new Set<(event: EventRecord) => void>();
  private head = 0;
  private size = 0;
  private dropped = 0;

  constructor(capacity = DEFAULT_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("RecentEventsBuffer capacity must be a positive integer");
    }
    this.capacity = capacity;
    this.records = new Array(capacity);
  }

  emit(event: EventRecord): void {
    const sanitized = sanitizeEventRecord(event);
    if (this.size === this.capacity) {
      this.records[this.head] = sanitized;
      this.head = (this.head + 1) % this.capacity;
      this.dropped += 1;
    } else {
      this.records[(this.head + this.size) % this.capacity] = sanitized;
      this.size += 1;
    }
    for (const listener of this.listeners) {
      try {
        listener(sanitized);
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
    if (!Number.isInteger(limit) || limit < 1) return { events: [], dropped: this.dropped };

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
    return { events, dropped: this.dropped };
  }

  subscribe(listener: (event: EventRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
