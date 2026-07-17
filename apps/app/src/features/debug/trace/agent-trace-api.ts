/** Programmatic, metadata-only access to the dev trace store for browser agents. */
import type { EventRecord, TraceStreamRef } from "@meridian/contracts/observability";

import { clearTraceEvents, getTraceSnapshot, subscribeToTraceEvents } from "./trace-store";

export interface AgentTraceFilter {
  transport?: TraceStreamRef["transport"];
  messageClass?: string;
  name?: string;
  direction?: NonNullable<TraceStreamRef["direction"]>;
  /** Matches the beginning of a stream id. */
  stream?: string;
}

export type AgentTraceWaitFilter = Omit<AgentTraceFilter, "stream">;

export interface MeridianTraceAPI {
  getEvents(filter?: AgentTraceFilter): EventRecord[];
  getStats(): { captured: number; ringDropped: number; tapErrors: number };
  waitForEvent(filter: AgentTraceWaitFilter, timeoutMs?: number): Promise<EventRecord | null>;
  clear(): void;
}

declare global {
  interface Window {
    __meridianTrace?: MeridianTraceAPI;
  }
}

function matchesFilter(record: EventRecord, filter: AgentTraceFilter): boolean {
  const stream = record.stream;
  if (filter.transport && stream?.transport !== filter.transport) return false;
  if (filter.messageClass && stream?.messageClass !== filter.messageClass) return false;
  if (filter.name && record.name !== filter.name) return false;
  if (filter.direction && stream?.direction !== filter.direction) return false;
  if (filter.stream && !stream?.streamId.startsWith(filter.stream)) return false;
  return true;
}

function capturedCount(snapshot: ReturnType<typeof getTraceSnapshot>): number {
  return snapshot.entries.length + snapshot.ringDropped;
}

function getEvents(filter: AgentTraceFilter = {}): EventRecord[] {
  return structuredClone(
    getTraceSnapshot().entries.filter((record) => matchesFilter(record, filter)),
  );
}

function getStats(): { captured: number; ringDropped: number; tapErrors: number } {
  const snapshot = getTraceSnapshot();
  return {
    captured: capturedCount(snapshot),
    ringDropped: snapshot.ringDropped,
    tapErrors: snapshot.tapErrors,
  };
}

function waitForEvent(
  filter: AgentTraceWaitFilter,
  timeoutMs = 10_000,
): Promise<EventRecord | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const unsubscribe = subscribeToTraceEvents((record) => {
      if (settled || !matchesFilter(record, filter)) return;

      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      unsubscribe();
      resolve(structuredClone(record));
    });

    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(null);
    }, timeoutMs);
  });
}

export const meridianTraceAPI: MeridianTraceAPI = {
  getEvents,
  getStats,
  waitForEvent,
  clear: clearTraceEvents,
};
