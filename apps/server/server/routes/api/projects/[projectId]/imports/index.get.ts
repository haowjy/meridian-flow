/** Newest open import summaries for the destination status rows and Continue import. */
import { createError, defineEventHandler, getQuery } from "nitro/h3";
import { resolveImportRoute } from "../../../../../lib/import-route.js";
export default defineEventHandler(async (event) => {
  const route = await resolveImportRoute(event);
  if (getQuery(event).open !== "1")
    throw createError({ statusCode: 400, message: "open_filter_required" });
  return route.read(() => route.service.listOpen(route.projectId));
});
