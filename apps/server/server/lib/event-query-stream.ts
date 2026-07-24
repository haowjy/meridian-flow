/** Bounded H3 SSE delivery for live recent-event subscriptions. */

import { createEventStream } from "nitro/h3";
import type { EventQuery, EventQueryFilter, EventRecord } from "../domains/observability/index.js";
import { eventMatchesLiveQueryFilter } from "./event-query-route.js";

const HEARTBEAT_MS = 25_000;
const MAX_PENDING_EVENTS = 1_000;

type PendingFrame = { event: EventRecord } | { comment: string };
type EventStreamInput = Parameters<typeof createEventStream>[0];

export function createRecentEventsStream(
  event: EventStreamInput,
  eventQuery: EventQuery,
  filter: EventQueryFilter,
): Promise<BodyInit> {
  const stream = createEventStream(event);
  const pending: PendingFrame[] = [];
  let draining = false;
  let closed = false;
  let unsubscribe: () => void = () => undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    pending.length = 0;
    if (heartbeat) clearInterval(heartbeat);
    event.req.signal.removeEventListener("abort", cleanup);
    unsubscribe();
  };
  const drain = async () => {
    if (draining || closed) return;
    draining = true;
    try {
      while (!closed) {
        const frame = pending.shift();
        if (!frame) break;
        if ("event" in frame) {
          await stream.push({
            ...(frame.event.eventId !== undefined && { id: frame.event.eventId }),
            data: JSON.stringify(frame.event),
          });
        } else {
          await stream.pushComment(frame.comment);
        }
      }
    } finally {
      draining = false;
    }
  };
  const enqueue = (frame: PendingFrame) => {
    if (closed) return;
    if (pending.length >= MAX_PENDING_EVENTS) {
      cleanup();
      void stream.close();
      return;
    }
    pending.push(frame);
    void drain().catch(() => {
      cleanup();
      void stream.close();
    });
  };

  unsubscribe = eventQuery.subscribe((record) => {
    if (eventMatchesLiveQueryFilter(record, filter)) enqueue({ event: record });
  });
  heartbeat = setInterval(() => enqueue({ comment: "heartbeat" }), HEARTBEAT_MS);
  heartbeat.unref();
  if (event.req.signal.aborted) cleanup();
  else event.req.signal.addEventListener("abort", cleanup, { once: true });
  stream.onClosed(cleanup);
  return stream.send();
}
