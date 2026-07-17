/**
 * Bounded client-side capture for dev-only observability events.
 *
 * This module intentionally has no React or transport dependency: any producer
 * can append the shared EventRecord envelope through the public API.
 */
import type { EventRecord } from "@meridian/contracts/observability";

export const TRACE_STORE_CAPACITY = 2_000;

export interface TraceSnapshot {
  readonly entries: readonly EventRecord[];
  readonly ringDropped: number;
  readonly tapErrors: number;
}

export interface TraceFilters {
  streamId: string;
  messageClass: string;
  direction: "" | "client_to_server" | "server_to_client";
  correlation: string;
}

const ring = new Array<EventRecord | undefined>(TRACE_STORE_CAPACITY);
const listeners = new Set<() => void>();
let start = 0;
let size = 0;
let ringDropped = 0;
let tapErrors = 0;
let snapshot: TraceSnapshot = { entries: [], ringDropped, tapErrors };

function rebuildSnapshot(): void {
  const entries = new Array<EventRecord>(size);
  for (let index = 0; index < size; index += 1) {
    entries[index] = ring[(start + index) % TRACE_STORE_CAPACITY] as EventRecord;
  }
  snapshot = { entries, ringDropped, tapErrors };
}

function publish(): void {
  rebuildSnapshot();
  for (const listener of listeners) listener();
}

/** Append an event, evicting the oldest event once the ring is full. */
export function appendTraceEvent(record: EventRecord): void {
  if (size < TRACE_STORE_CAPACITY) {
    ring[(start + size) % TRACE_STORE_CAPACITY] = record;
    size += 1;
  } else {
    ring[start] = record;
    start = (start + 1) % TRACE_STORE_CAPACITY;
    ringDropped += 1;
  }
  publish();
}

/** Record a producer/tap failure without requiring a synthetic EventRecord. */
export function noteTapError(): void {
  tapErrors += 1;
  publish();
}

export function subscribeToTraceStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTraceSnapshot(): TraceSnapshot {
  return snapshot;
}

/** Clear captured events and session counters from the viewer. */
export function clearTraceEvents(): void {
  ring.fill(undefined);
  start = 0;
  size = 0;
  ringDropped = 0;
  tapErrors = 0;
  publish();
}

/** Shared projection used by the table and all three export paths. */
export function filterTraceEntries(
  entries: readonly EventRecord[],
  filters: TraceFilters,
): EventRecord[] {
  const correlationNeedle = filters.correlation.trim().toLocaleLowerCase();
  return entries.filter((record) => {
    const stream = record.stream;
    if (filters.streamId && stream?.streamId !== filters.streamId) return false;
    if (filters.messageClass && stream?.messageClass !== filters.messageClass) return false;
    if (filters.direction && stream?.direction !== filters.direction) return false;
    if (!correlationNeedle) return true;

    const haystack = [
      record.correlation?.documentId,
      record.correlation?.branchId,
      stream?.streamId,
    ]
      .filter((value): value is string => typeof value === "string")
      .join("\n")
      .toLocaleLowerCase();
    return haystack.includes(correlationNeedle);
  });
}
