import type { EventCorrelation, EventLevel, EventRecord } from "./event-sink.js";

export interface EventQueryFilter {
  eventId?: string;
  source?: string;
  name?: string;
  excludeName?: string;
  level?: EventLevel;
  correlation?: Partial<EventCorrelation>;
  sinceEventId?: string;
  sinceTimestamp?: string;
  limit?: number;
}

export interface EventQueryResult {
  events: EventRecord[];
  dropped: number;
  droppedBytes: number;
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

export function eventMatchesQueryFilter(event: EventRecord, filter: EventQueryFilter): boolean {
  if (filter.eventId !== undefined && event.eventId !== filter.eventId) return false;
  if (filter.source !== undefined && event.source !== filter.source) return false;
  if (filter.name !== undefined && !event.name.startsWith(filter.name)) return false;
  if (filter.excludeName !== undefined && event.name === filter.excludeName) return false;
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
