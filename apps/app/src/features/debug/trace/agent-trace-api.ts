/** Programmatic, metadata-only access to the dev trace store for browser agents. */
import type { EventRecord } from "@meridian/contracts/observability";

import {
  clearTraceEvents,
  getTraceSnapshot,
  subscribeToTraceStore,
  type TraceSnapshot,
} from "./trace-store";

export interface AgentTraceFilter {
  transport?: string;
  messageClass?: string;
  direction?: string;
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
  if (filter.direction && stream?.direction !== filter.direction) return false;
  if (filter.stream && !stream?.streamId.startsWith(filter.stream)) return false;
  return true;
}

function capturedCount(snapshot: TraceSnapshot): number {
  return snapshot.entries.length + snapshot.ringDropped;
}

function getEvents(filter: AgentTraceFilter = {}): EventRecord[] {
  return getTraceSnapshot().entries.filter((record) => matchesFilter(record, filter));
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
    const initialSnapshot = getTraceSnapshot();
    let observedCaptured = capturedCount(initialSnapshot);
    let observedTail = initialSnapshot.entries.at(-1);
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const unsubscribe = subscribeToTraceStore(() => {
      const snapshot = getTraceSnapshot();
      const currentCaptured = capturedCount(snapshot);
      const priorTailWasDiscarded =
        observedTail !== undefined && !snapshot.entries.includes(observedTail);
      const appendedCount =
        currentCaptured < observedCaptured || priorTailWasDiscarded
          ? snapshot.entries.length
          : currentCaptured - observedCaptured;
      observedCaptured = currentCaptured;
      observedTail = snapshot.entries.at(-1);
      if (appendedCount === 0) return;

      const newEntries = snapshot.entries.slice(-Math.min(appendedCount, snapshot.entries.length));
      const match = newEntries.find((record) => matchesFilter(record, filter));
      if (!match || settled) return;

      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      unsubscribe();
      resolve(match);
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
