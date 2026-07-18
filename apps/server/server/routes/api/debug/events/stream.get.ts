/** GET /api/debug/events/stream — authenticated, dev-only live observability SSE feed. */
import { createError, createEventStream, defineEventHandler, getQuery } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import {
  eventMatchesLiveQueryFilter,
  parseEventQueryFilter,
} from "../../../../lib/event-query-route.js";

const HEARTBEAT_MS = 25_000;

export default defineEventHandler(async (event) => {
  const { app } = await requireAppUser(event);
  if (!app.eventQuery) {
    throw createError({ statusCode: 404, message: "Recent events are not enabled" });
  }

  const filter = parseEventQueryFilter(getQuery(event));
  const stream = createEventStream(event);
  const unsubscribe = app.eventQuery.subscribe((record) => {
    if (!eventMatchesLiveQueryFilter(record, filter)) return;
    void stream.push({
      ...(record.eventId !== undefined && { id: record.eventId }),
      data: JSON.stringify(record),
    });
  });
  const heartbeat = setInterval(() => void stream.pushComment("heartbeat"), HEARTBEAT_MS);
  heartbeat.unref();
  stream.onClosed(() => {
    clearInterval(heartbeat);
    unsubscribe();
  });
  return stream.send();
});
