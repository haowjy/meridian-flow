/** Unacknowledged imports across the authenticated writer's live projects. */
import { createError, defineEventHandler, getQuery } from "nitro/h3";
import { requireAppUser } from "../../../lib/auth-gate.js";
export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  if (getQuery(event).open !== "1")
    throw createError({ statusCode: 400, message: "open_filter_required" });
  return app.openImports(user.userId);
});
