/** EventQuery port: bounded recent-event history plus live sanitized delivery. */
import type { EventCorrelation, EventLevel, EventRecord } from "./event-sink.js";

export interface EventQueryFilter {
  /** Exact source match. */
  source?: string;
  /** Event-name prefix match. */
  name?: string;
  /** Inclusive severity floor. */
  level?: EventLevel;
  /** Equality on every provided correlation field. */
  correlation?: Partial<EventCorrelation>;
  /** Records inserted after this id, exclusive. */
  sinceEventId?: string;
  /** Records whose ISO timestamp is at or after this value. */
  sinceTimestamp?: string;
  /** Maximum records returned, newest first. Defaults to 200. */
  limit?: number;
}

export interface EventQueryResult {
  events: EventRecord[];
  /** Lifetime count of records evicted from the query surface. */
  dropped: number;
}

export interface EventQuery {
  query(filter: EventQueryFilter): EventQueryResult;
  subscribe(listener: (event: EventRecord) => void): () => void;
}

const LEVEL_RANK: Record<EventLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

/** Match scalar filters; ordered query owners apply the event-id cursor. */
export function eventMatchesQueryFilter(event: EventRecord, filter: EventQueryFilter): boolean {
  if (filter.source !== undefined && event.source !== filter.source) return false;
  if (filter.name !== undefined && !event.name.startsWith(filter.name)) return false;
  if (filter.level !== undefined && LEVEL_RANK[event.level] < LEVEL_RANK[filter.level])
    return false;
  if (filter.sinceTimestamp !== undefined && event.timestamp < filter.sinceTimestamp) return false;
  if (filter.correlation) {
    for (const [key, value] of Object.entries(filter.correlation)) {
      if (value !== undefined && event.correlation?.[key as keyof EventCorrelation] !== value) {
        return false;
      }
    }
  }
  return true;
}
