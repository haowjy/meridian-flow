/** GET /api/debug/events/stream — authenticated, dev-only live observability SSE feed. */
import { createError, defineEventHandler, getQuery } from "nitro/h3";
import { requireAppUser } from "../../../../lib/auth-gate.js";
import { parseEventQueryFilter } from "../../../../lib/event-query-route.js";
import { createRecentEventsStream } from "../../../../lib/event-query-stream.js";

export default defineEventHandler(async (event) => {
  const { app } = await requireAppUser(event);
  if (!app.eventQuery) {
    throw createError({ statusCode: 404, message: "Recent events are not enabled" });
  }
  return createRecentEventsStream(event, app.eventQuery, parseEventQueryFilter(getQuery(event)));
});
