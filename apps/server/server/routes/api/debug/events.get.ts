/** GET /api/debug/events — authenticated, dev-only filtered recent observability records. */
import { createError, defineEventHandler, getQuery } from "nitro/h3";
import { requireAppUser } from "../../../lib/auth-gate.js";
import { parseEventQueryFilter } from "../../../lib/event-query-route.js";

export default defineEventHandler(async (event) => {
  const { app } = await requireAppUser(event);
  if (!app.eventQuery) {
    throw createError({ statusCode: 404, message: "Recent events are not enabled" });
  }
  return app.eventQuery.query(parseEventQueryFilter(getQuery(event)));
});
