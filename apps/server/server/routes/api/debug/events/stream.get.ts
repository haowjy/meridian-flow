/** GET /api/debug/events/stream — authenticated, dev-only live observability SSE feed. */
import { createError, createEventStream, defineEventHandler, getQuery } from "nitro/h3";
import type { EventRecord } from "../../../../domains/observability/index.js";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import {
  eventMatchesLiveQueryFilter,
  parseEventQueryFilter,
} from "../../../../lib/event-query-route.js";

const HEARTBEAT_MS = 25_000;
const MAX_PENDING_EVENTS = 1_000;

type PendingFrame = { event: EventRecord } | { comment: string };

export default defineEventHandler(async (event) => {
  const { app } = await requireAppUser(event);
  if (!app.eventQuery) {
    throw createError({ statusCode: 404, message: "Recent events are not enabled" });
  }

  const filter = parseEventQueryFilter(getQuery(event));
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

  unsubscribe = app.eventQuery.subscribe((record) => {
    if (!eventMatchesLiveQueryFilter(record, filter)) return;
    enqueue({ event: record });
  });
  heartbeat = setInterval(() => enqueue({ comment: "heartbeat" }), HEARTBEAT_MS);
  heartbeat.unref();
  event.req.signal.addEventListener("abort", cleanup, { once: true });
  stream.onClosed(cleanup);
  return stream.send();
});
