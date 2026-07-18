/** Native SSE producer that joins server observability records into the trace ring. */
import type { EventRecord } from "@meridian/contracts/observability";

import { appendTraceEvent } from "./trace-store";

const SERVER_FEED_PATH = "/api/debug/events/stream";

export type ServerFeedState = "idle" | "connecting" | "open" | "error";

let eventSource: EventSource | undefined;
let state: ServerFeedState = "idle";
const listeners = new Set<() => void>();

function setState(next: ServerFeedState): void {
  if (state === next) return;
  state = next;
  for (const listener of listeners) listener();
}

function isEventRecord(value: unknown): value is EventRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.timestamp === "string" &&
    typeof candidate.source === "string" &&
    typeof candidate.name === "string"
  );
}

/** Open the same-origin server feed. Native EventSource owns reconnection. */
export function startServerFeed(): void {
  if (eventSource) return;

  setState("connecting");
  try {
    const source = new EventSource(SERVER_FEED_PATH);
    eventSource = source;
    source.onopen = () => {
      if (eventSource === source) setState("open");
    };
    source.onerror = () => {
      if (eventSource === source) setState("error");
    };
    source.onmessage = (message) => {
      if (eventSource !== source) return;
      try {
        const record: unknown = JSON.parse(message.data);
        if (isEventRecord(record)) appendTraceEvent(record);
      } catch {
        // A malformed debug frame is skipped without interrupting the native feed.
      }
    };
  } catch {
    setState("error");
  }
}

/** Close the feed and return its observable state to idle. */
export function stopServerFeed(): void {
  eventSource?.close();
  eventSource = undefined;
  setState("idle");
}

export function subscribeToServerFeed(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getServerFeedState(): ServerFeedState {
  return state;
}
